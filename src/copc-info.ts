// The `copc` VLR, record 1: 160 bytes that make a LAS file an octree.
//
// It must be the FIRST VLR, immediately after the header, which is what lets a
// reader identify a COPC file from one ranged GET of its first few kilobytes
// without ever seeing the rest.

import { VoxelkloudError } from "@voxelkloud/core";
import type { BoundingBox } from "@voxelkloud/core";

/** User id and record id of the info VLR. */
export const COPC_USER_ID = "copc";
export const COPC_INFO_RECORD_ID = 1;
/** Record id of the hierarchy EVLR, same user id. */
export const COPC_HIERARCHY_RECORD_ID = 1000;
/** Bytes of the info VLR payload. Fixed by the spec. */
export const COPC_INFO_SIZE = 160;
/** Bytes of one hierarchy entry. Also fixed. */
export const COPC_ENTRY_SIZE = 32;

export interface CopcInfo {
  /** Centre of the root cube, absolute CRS. */
  readonly center: readonly [number, number, number];
  /** Half the root cube's edge. The octree subdivides `center ± halfSize`. */
  readonly halfSize: number;
  /** Point spacing at the root level. Halves at each level below. */
  readonly spacing: number;
  /** Where the root hierarchy page lives, absolute offset into the file. */
  readonly rootHierarchyOffset: number;
  readonly rootHierarchySize: number;
  readonly gpsTimeRange: readonly [number, number];
}

/** The cube the octree subdivides — the INDEXING volume, not the data extent. */
export function copcCube(info: CopcInfo): BoundingBox {
  const [cx, cy, cz] = info.center;
  const h = info.halfSize;
  return {
    min: [cx - h, cy - h, cz - h],
    max: [cx + h, cy + h, cz + h],
  };
}

/**
 * Parse the info VLR payload.
 *
 * @throws {VoxelkloudError} `"invalid-metadata"` when the payload is the wrong
 *   size or declares a cube with no volume — either means the file is not the
 *   COPC it claims to be, and every offset derived from it would be fiction.
 */
export function parseCopcInfo(record: Uint8Array): CopcInfo {
  if (record.byteLength < COPC_INFO_SIZE) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `The COPC info VLR is ${record.byteLength} bytes; the spec fixes it at ` +
        `${COPC_INFO_SIZE}.`,
      { path: "copc:1" },
    );
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const info: CopcInfo = {
    center: [
      view.getFloat64(0, true),
      view.getFloat64(8, true),
      view.getFloat64(16, true),
    ],
    halfSize: view.getFloat64(24, true),
    spacing: view.getFloat64(32, true),
    // u64 through Number: a file above 2^53 bytes is not a thing, and a bigint
    // here would infect every arithmetic site downstream.
    rootHierarchyOffset: Number(view.getBigUint64(40, true)),
    rootHierarchySize: Number(view.getBigUint64(48, true)),
    gpsTimeRange: [view.getFloat64(56, true), view.getFloat64(64, true)],
  };

  if (!(info.halfSize > 0) || !Number.isFinite(info.halfSize)) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `The COPC info VLR declares a half-size of ${info.halfSize}. Every node ` +
        `box is derived from it, so nothing can be addressed.`,
      { path: "copc:1.halfsize" },
    );
  }
  if (!(info.spacing > 0) || !Number.isFinite(info.spacing)) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `The COPC info VLR declares a root spacing of ${info.spacing}. That is ` +
        `the level-of-detail quantum; without it no node can be scheduled.`,
      { path: "copc:1.spacing" },
    );
  }
  if (
    info.rootHierarchySize <= 0 ||
    info.rootHierarchySize % COPC_ENTRY_SIZE !== 0
  ) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `The COPC info VLR declares a root hierarchy page of ` +
        `${info.rootHierarchySize} bytes, which is not a whole number of ` +
        `${COPC_ENTRY_SIZE}-byte entries.`,
      { path: "copc:1.root_hier_size" },
    );
  }
  return info;
}
