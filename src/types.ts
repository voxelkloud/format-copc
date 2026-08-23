import type {
  PointAttribute,
  PointCloudSourceBase,
  PointCloudWarning,
} from "@voxelkloud/core";
import type { LasLayout } from "@voxelkloud/format-las";
import type { CopcInfo } from "./copc-info.js";

/** Where a node's laszip chunk lives inside the one file. */
export interface CopcNodePayload {
  readonly offset: number;
  readonly byteSize: number;
}

/** Where a hierarchy page lives. Same shape, different bytes behind it. */
export interface CopcPageRef {
  readonly offset: number;
  readonly byteSize: number;
}

export type CopcWarningCode =
  | "extra-bytes-mismatch"
  | "undecodable-attribute"
  | "degenerate-range"
  | "duplicate-attribute-name"
  | "unexpected-point-format"
  | "legacy-point-count";

export type CopcWarning = PointCloudWarning<CopcWarningCode>;

/**
 * A COPC cloud, minus its points.
 *
 * Everything a renderer needs is on {@link PointCloudSourceBase}; what is added
 * here is what a COPC-specific caller might reach for — the info VLR, the LAS
 * header fields, and the record layout the reader will decode against.
 */
export interface CopcSource extends PointCloudSourceBase {
  /** Absolute URL of the `.copc.laz`. Every request is a range into it. */
  readonly url: string;
  readonly copc: CopcInfo;
  /** LAS point data record format: 6, 7 or 8. */
  readonly pointFormat: number;
  /** Bytes per decompressed record, extra bytes included. */
  readonly pointSize: number;
  /** File quantization, from the LAS header. */
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  /** The record layout every node decodes against. */
  readonly layout: LasLayout;
  /** Payload of the `laszip encoded` VLR — what a chunk decoder is built from. */
  readonly laszipRecord: Uint8Array;
  readonly attributes: readonly PointAttribute[];
  readonly warnings: readonly CopcWarning[];
}
