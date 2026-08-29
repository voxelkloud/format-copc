// Identify and open a COPC file from its first few kilobytes.
//
// One ranged GET is the whole load: the LAS header, the `copc` info VLR, the
// `laszip` VLR and the Extra Bytes descriptor all live in the first block of
// the file, by spec — the info VLR is required to be first. If that block turns
// out to be too short for the VLR directory, `readLasHeader` says so and a
// second, wider read follows rather than a guess.

import { VoxelkloudError } from "@voxelkloud/core";
import type { LoadSourceOptions, PointCloudTransport } from "@voxelkloud/core";
import {
  GEOKEY_ASCII_RECORD_ID,
  GEOKEY_DIRECTORY_RECORD_ID,
  PROJECTION_USER_ID,
  WKT_RECORD_ID,
  lasCrs,
  lasLayout,
} from "@voxelkloud/format-las";
import {
  LASZIP_RECORD_ID,
  LASZIP_USER_ID,
  initLazCodec,
  readLasHeader,
} from "@voxelkloud/wasm-codecs";
import {
  COPC_INFO_RECORD_ID,
  COPC_USER_ID,
  copcCube,
  parseCopcInfo,
} from "./copc-info.js";
import { fetchHead } from "./range.js";
import type { CopcSource, CopcWarning, CopcWarningCode } from "./types.js";

/**
 * Bytes read on the first request.
 *
 * The header is 375, the info VLR 214 with its own header, the laszip VLR
 * around 106, an Extra Bytes descriptor 192 apiece. 8 KiB covers a file with
 * dozens of extra dimensions and still costs one round trip; the retry below
 * covers anything larger.
 */
const HEAD_BYTES = 8192;
/** Second attempt, when the VLR directory did not fit the first. */
const WIDE_HEAD_BYTES = 1024 * 1024;

/** The `LASF_Spec` Extra Bytes VLR. */
const EXTRA_BYTES_USER_ID = "LASF_Spec";
const EXTRA_BYTES_RECORD_ID = 4;

const defaultFetch = (input: string, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

/**
 * Load a COPC file's header and build its source.
 *
 * @throws {VoxelkloudError} `"unsupported-format"` when the file is LAS but not
 *   COPC, `"invalid-metadata"` when it is COPC and self-inconsistent, plus
 *   whatever the transport throws.
 */
export async function loadCopcSource(
  input: string | URL,
  options: LoadSourceOptions = {},
): Promise<CopcSource> {
  const url = input instanceof URL ? input.href : input;
  const transport: PointCloudTransport = {
    fetch: options.fetch ?? defaultFetch,
    requestInit: options.requestInit,
  };

  // The codec is needed for the header reader itself, not just for points: LAS
  // framing lives in the wasm alongside the decoder that consumes it.
  await initLazCodec();

  const warnings: CopcWarning[] = [];
  const emitted = new Set<CopcWarningCode>();
  const warn = (code: CopcWarningCode, path: string, message: string): void => {
    if (emitted.has(code)) return;
    emitted.add(code);
    warnings.push({ code, path, message });
  };

  // `fetchHead` e não `fetchRange`: os 8 KiB são um PALPITE que cobre o
  // cabeçalho e o diretório de VLRs de quase todo COPC, não um intervalo que o
  // arquivo prometeu ter. Num arquivo menor que isso — um ladrilho de umas
  // centenas de pontos — pedir 8192 bytes exatos falhava, e o arquivo era
  // perfeitamente válido.
  let head = await fetchHead(transport, url, HEAD_BYTES, options.signal);
  let header = readLasHeader(head);
  if (!header.vlrsComplete) {
    // The VLR directory ran past the first read. Its true end is declared, so
    // the second read is exact rather than another guess.
    const need = Math.min(header.offsetToPointData, WIDE_HEAD_BYTES);
    header.free();
    head = await fetchHead(transport, url, need, options.signal);
    header = readLasHeader(head);
    if (!header.vlrsComplete) {
      header.free();
      throw new VoxelkloudError(
        "invalid-metadata",
        `${url} declares a VLR directory that does not fit in the ` +
          `${need} bytes before its own point data offset.`,
        { url },
      );
    }
  }

  try {
    const infoVlr = header.findVlr(COPC_USER_ID, COPC_INFO_RECORD_ID);
    if (infoVlr === undefined) {
      throw new VoxelkloudError(
        "unsupported-format",
        `${url} is a LAS ${header.version} file but carries no \`copc\` VLR, ` +
          `so it is not Cloud Optimized Point Cloud — there is no octree in it ` +
          `to stream. Convert it with \`untwine\` or PDAL's \`writers.copc\`.`,
        { url },
      );
    }
    const copc = parseCopcInfo(infoVlr.data);
    infoVlr.free();

    if (!header.compressed) {
      throw new VoxelkloudError(
        "invalid-metadata",
        `${url} carries a \`copc\` VLR but its point data is not laszip ` +
          `compressed. COPC is defined over LAZ; an uncompressed file has no ` +
          `chunks for the hierarchy to point at.`,
        { url },
      );
    }
    const laszipVlr = header.findVlr(LASZIP_USER_ID, LASZIP_RECORD_ID);
    if (laszipVlr === undefined) {
      throw new VoxelkloudError(
        "invalid-metadata",
        `${url} declares laszip-compressed points but has no \`laszip encoded\` ` +
          `VLR, so nothing describes how to decompress them.`,
        { url },
      );
    }
    const laszipRecord = laszipVlr.data;
    laszipVlr.free();

    // COPC 1.0 fixes the point format at 6, 7 or 8. A file outside that is
    // readable anyway — the LAS record layout is known for every format — so
    // this warns rather than refuses, and names what is out of spec.
    if (header.pointFormat < 6 || header.pointFormat > 8) {
      warn(
        "unexpected-point-format",
        "header.point_data_record_format",
        `${url} uses LAS point format ${header.pointFormat}. COPC 1.0 allows ` +
          `only 6, 7 and 8. The record is decoded through its declared format; ` +
          `treat anything surprising as the writer's bug, not this reader's.`,
      );
    }

    const extraVlr = header.findVlr(EXTRA_BYTES_USER_ID, EXTRA_BYTES_RECORD_ID);
    const extraBytes = extraVlr?.data;
    extraVlr?.free();

    // The projection VLRs are in the head read already, so the CRS costs no
    // extra request. COPC is LAS 1.4, which requires WKT, but a writer may also
    // emit the GeoTIFF keys for older readers and both are offered here.
    const wktVlr = header.findVlr(PROJECTION_USER_ID, WKT_RECORD_ID);
    const geoKeyVlr = header.findVlr(
      PROJECTION_USER_ID,
      GEOKEY_DIRECTORY_RECORD_ID,
    );
    const geoAsciiVlr = header.findVlr(
      PROJECTION_USER_ID,
      GEOKEY_ASCII_RECORD_ID,
    );
    const crs = lasCrs({
      ...(wktVlr !== undefined ? { wkt: wktVlr.data } : {}),
      ...(geoKeyVlr !== undefined ? { geoKeyDirectory: geoKeyVlr.data } : {}),
      ...(geoAsciiVlr !== undefined ? { geoAscii: geoAsciiVlr.data } : {}),
    });
    wktVlr?.free();
    geoKeyVlr?.free();
    geoAsciiVlr?.free();

    const bounds = copcCube(copc);
    const tightBoundingBox = {
      min: [header.min[0]!, header.min[1]!, header.min[2]!] as [number, number, number],
      max: [header.max[0]!, header.max[1]!, header.max[2]!] as [number, number, number],
    };

    const layout = lasLayout({
      format: header.pointFormat,
      pointSize: header.pointSize,
      ...(extraBytes !== undefined ? { extraBytes } : {}),
      // Position's declared domain is the TIGHT extent, not the octree cube:
      // that is what an elevation ramp and a fit-to-view want, and it matches
      // what a Potree manifest puts on its own position attribute.
      bounds: tightBoundingBox,
      gpsTimeRange: copc.gpsTimeRange,
    });
    for (const w of layout.warnings) warn(w.code, w.path, w.message);

    const attributes = layout.attributes.map((a) => a.attribute);
    const attributesByName = new Map(
      layout.attributes.map((a) => [a.attribute.name, a.attribute] as const),
    );

    const source: CopcSource = {
      url,
      copc,
      pointFormat: header.pointFormat,
      pointSize: header.pointSize,
      scale: [header.scale[0]!, header.scale[1]!, header.scale[2]!],
      offset: [header.offset[0]!, header.offset[1]!, header.offset[2]!],
      layout,
      laszipRecord,
      attributes,
      attributesByName,
      bounds,
      tightBoundingBox,
      pointCount: header.pointCount,
      ...(crs !== undefined ? { crs } : {}),
      warnings,
      transport,
    };
    return Object.freeze(source);
  } finally {
    header.free();
  }
}
