import type { FormatProbe, PointCloudFormat } from "@voxelkloud/core";
import { COPC_INFO_RECORD_ID, COPC_USER_ID } from "./copc-info.js";
import { openCopcTree } from "./hierarchy.js";
import { loadCopcSource } from "./load.js";
import { openCopcPoints } from "./points-reader.js";
import type { CopcSource } from "./types.js";

/**
 * The COPC driver, as a registry entry.
 *
 * NOT registered by default in `@voxelkloud/loader`, and that is a bundle
 * decision rather than a judgement: this driver pulls in a wasm LAZ decoder,
 * and an app that only reads Potree should not carry 148 KB of it to find that
 * out. One `formats.register(copcFormat)` turns it on.
 */
export const copcFormat: PointCloudFormat<CopcSource> = {
  id: "copc",
  label: "COPC",

  sniffUrl(url) {
    const path = (url.split(/[?#]/)[0] ?? "").toLowerCase();
    // The conventional double extension. Decisive on shape alone: nothing else
    // is served as `.copc.laz`.
    if (path.endsWith(".copc.laz")) return 3;
    // A bare `.laz` may be COPC and may be a plain LAZ file; only the VLR
    // directory separates them, and `sniff` reads it.
    if (path.endsWith(".laz") || path.endsWith(".las")) return 2;
    return 0;
  },

  probeUrl(url) {
    // COPC identifies itself from its own bytes, not from a sibling document.
    // The engine's probe is a plain GET, so what comes back is the head of the
    // file — enough for `LASF`, and no more is needed to ORDER candidates.
    const path = (url.split(/[?#]/)[0] ?? "").toLowerCase();
    if (path.endsWith(".laz") || path.endsWith(".las")) return url;
    return undefined;
  },

  sniff(probe: FormatProbe) {
    const bytes = probe.bytes;
    if (bytes === undefined || bytes.byteLength < 4) return 0;
    // `LASF`. Every LAS and LAZ file starts with it, COPC included.
    if (!(bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53 && bytes[3] === 0x46)) {
      return 0;
    }
    // AND the `copc` VLR, which is what separates a COPC from the ordinary LAZ
    // it is otherwise indistinguishable from. The spec requires it FIRST, right
    // after the header, so this is one offset rather than a walk — and getting
    // it wrong the other way is expensive: claiming a plain LAZ decisively
    // stops the search, and the single-file driver never gets the file it is
    // there to handle.
    return hasCopcVlr(bytes) ? 3 : 0;
  },

  load: (url, options) => loadCopcSource(url, options),

  openTree: (source, options) =>
    openCopcTree(source, { signal: options?.signal }),

  openPoints: (source, options) => openCopcPoints(source, options),
};

/** Re-exported so a caller can pin the driver by its stable id. */
export const COPC_FORMAT_ID = copcFormat.id;

/**
 * Whether the first VLR is `copc`, record 1.
 *
 * The spec requires it there — "the `copc` VLR MUST be the first VLR in the
 * file" — so this reads the header's own `header_size` and looks at exactly one
 * record rather than walking a directory that may run past the probe.
 */
function hasCopcVlr(bytes: Uint8Array): boolean {
  // Offsets 94 (header_size) and 100 (VLR count) exist in every LAS version.
  if (bytes.byteLength < 104) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(94, true);
  if (view.getUint32(100, true) === 0) return false;
  // 2 reserved + 16 user id.
  const at = headerSize + 2;
  if (at + 18 > bytes.byteLength) return false;

  const userId = new TextDecoder()
    .decode(bytes.subarray(at, at + 16))
    .replace(/\0+$/u, "");
  return (
    userId === COPC_USER_ID &&
    view.getUint16(at + 16, true) === COPC_INFO_RECORD_ID
  );
}
