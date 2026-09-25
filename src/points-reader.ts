// One COPC node: a ranged GET, a laszip chunk, a decoded node.
//
// The whole reason B1 came first. A COPC node IS a bare laszip chunk sitting at
// an offset in the file — no chunk table in front of it, no header — and the
// point count comes from the hierarchy entry rather than from the bytes. That
// is exactly the shape `LazChunkDecoder` takes, so this file is a fetch, a
// decode and a record walk with nothing in between.

import { VoxelkloudError } from "@voxelkloud/core";
import type {
  DecodedPointData,
  OpenPointsOptions,
  PointCloudNode,
  PointNodeRef,
  PointReader,
  ReadPointsOptions,
} from "@voxelkloud/core";
import { createLasDecodePlan, decodeLasRecords } from "@voxelkloud/format-las";
import type { LasDecodePlan } from "@voxelkloud/format-las";
import { LazChunkDecoder, lazSelectionForAttributes } from "@voxelkloud/wasm-codecs";
import { DecodePool } from "./decode-pool.js";
import { fetchRange } from "./range.js";
import type { CopcNodePayload, CopcSource } from "./types.js";

/** A COPC tree node, once the driver has put its payload on it. */
type CopcNode = PointCloudNode & {
  readonly payload?: CopcNodePayload | undefined;
  readonly name?: string;
};

export interface CopcPointReader extends PointReader {
  /** The decode plan, resolved once for this cloud. */
  readonly plan: LasDecodePlan;
  /**
   * The laszip field mask this reader decodes with.
   *
   * Diagnostics, and the one number that says whether the selective path is
   * doing anything: it is the difference between spending time on the four
   * dimensions a viewer binds and on the eighteen a modern survey record
   * carries.
   */
  readonly lazSelection: number;
  /**
   * Workers decoding for this reader right now. `0` means every node is
   * decoded on the calling thread — either because the caller asked for that,
   * or because no worker could be started here.
   */
  readonly decodeWorkers: number;
}

/**
 * Open a reader over one COPC cloud.
 *
 * Builds ONE {@link LazChunkDecoder} for the whole file. Parsing the laszip VLR
 * is the expensive part of a chunk decode and it does not change between nodes,
 * so a decoder per node would pay it thousands of times.
 */
export function openCopcPoints(
  source: CopcSource,
  options: OpenPointsOptions = {},
): CopcPointReader {
  const plan = createLasDecodePlan(source.layout, {
    ...options,
    scale: [source.scale[0], source.scale[1], source.scale[2]],
    offset: [source.offset[0], source.offset[1], source.offset[2]],
    cloudOrigin: [
      source.bounds.min[0],
      source.bounds.min[1],
      source.bounds.min[2],
    ],
  });

  let decoder: LazChunkDecoder | undefined = new LazChunkDecoder(
    source.laszipRecord,
  );
  if (decoder.pointSize !== source.pointSize) {
    const declared = decoder.pointSize;
    decoder.free();
    decoder = undefined;
    throw new VoxelkloudError(
      "invalid-metadata",
      `${source.url}: the laszip VLR describes a ${declared}-byte record but ` +
        `the LAS header declares ${source.pointSize}. Every node would decode ` +
        `misaligned.`,
      { url: source.url },
    );
  }

  // THE FIELD MASK, resolved once from the plan the caller just got.
  //
  // The plan already says which dimensions will be read back, so the mask is a
  // restatement of it rather than a second decision that could drift out of
  // step with the first. A viewer asks for position and colour, sometimes
  // classification; the record carries eighteen dimensions. Measured over
  // `demo/data` on point format 6/7/8 records: 1.9 us/point for everything
  // against 0.93 for position plus colour.
  const lazSelection = lazSelectionForAttributes(
    plan.fields.map((f) => f.attribute.name),
  );

  // Started HERE rather than on the first read, so the boot overlaps the first
  // node's fetch instead of queueing behind it. Nothing awaits it: until a
  // worker answers `ready` the pool reports size 0 and nodes decode inline, so
  // the node that turns the canvas from black to drawn never waits for a
  // worker that is still instantiating its wasm.
  const pool =
    options.decodeWorkers === false
      ? undefined
      : new DecodePool({
          laszipRecord: source.laszipRecord,
          plan,
          ...(typeof options.decodeWorkers === "number"
            ? { workers: options.decodeWorkers }
            : {}),
        });

  return {
    plan,
    lazSelection,

    get decodeWorkers(): number {
      return pool?.available === true ? pool.size : 0;
    },

    hasPayload(node: PointCloudNode) {
      const payload = (node as CopcNode).payload;
      // A placeholder for a hierarchy page not yet fetched has no payload, and
      // a COPC node may legitimately have a point count with a zero-byte chunk.
      return payload !== undefined && payload.byteSize > 0 && node.numPoints > 0;
    },

    packingFor(name) {
      return plan.fields.find((f) => f.attribute.name === name)?.pack;
    },

    async read(
      node: PointNodeRef,
      read: ReadPointsOptions = {},
    ): Promise<DecodedPointData> {
      if (decoder === undefined) {
        throw new VoxelkloudError(
          "unsupported-point-data",
          `This COPC reader has been disposed.`,
          { url: source.url },
        );
      }
      const payload = (node as unknown as CopcNode).payload;
      if (payload === undefined || payload.byteSize === 0) {
        throw new VoxelkloudError(
          "unsupported-point-data",
          `Node ${node.name} has no laszip chunk of its own. Ask ` +
            `\`hasPayload\` before reading — a placeholder for an unfetched ` +
            `hierarchy page looks exactly like this.`,
          { url: source.url, path: node.name },
        );
      }

      const chunk = await fetchRange(
        source.transport,
        source.url,
        payload.offset,
        payload.byteSize,
        read.signal,
      );
      const computeBounds = read.computeBounds ?? plan.computeBounds;

      // OFF-THREAD WHEN THERE IS A THREAD, inline otherwise — and the fallback
      // is a normal outcome rather than an error path. A pool that never
      // started reports size 0 for the life of the reader, so this branch
      // settles once and costs a property read afterwards.
      if (pool !== undefined && pool.available && pool.size > 0) {
        return pool.decode(
          chunk,
          {
            index: node.index,
            name: node.name,
            numPoints: node.numPoints,
            minX: node.minX,
            minY: node.minY,
            minZ: node.minZ,
            maxX: node.maxX,
            maxY: node.maxY,
            maxZ: node.maxZ,
          },
          lazSelection,
          computeBounds,
          read.signal,
        );
      }

      // The point count comes from the hierarchy, never from the bytes: a
      // laszip chunk does not carry one for the sequential formats, and
      // trusting a length division would silently truncate.
      const records = decoder.decodeSelective(
        chunk,
        node.numPoints,
        lazSelection,
      );
      return decodeLasRecords(plan, node, records, { computeBounds });
    },

    dispose() {
      pool?.dispose();
      decoder?.free();
      decoder = undefined;
    },
  };
}
