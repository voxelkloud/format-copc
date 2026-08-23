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
import { LazChunkDecoder } from "@voxelkloud/wasm-codecs";
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

  return {
    plan,

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
      // The point count comes from the hierarchy, never from the bytes: a
      // laszip chunk does not carry one for the sequential formats, and
      // trusting a length division would silently truncate.
      const records = decoder.decode(chunk, node.numPoints);
      return decodeLasRecords(
        plan,
        node,
        records,
        read.computeBounds === undefined ? {} : { computeBounds: read.computeBounds },
      );
    },

    dispose() {
      decoder?.free();
      decoder = undefined;
    },
  };
}
