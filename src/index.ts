// @voxelkloud/format-copc — the Cloud Optimized Point Cloud driver.
//
// One file, one HTTP host, no conversion step: a COPC file is a LAS 1.4 file
// whose points are laszip chunks arranged as an octree, with the hierarchy in
// an EVLR at the end. Everything this driver does is a byte range into that one
// URL.
//
// What is genuinely COPC lives here: the `copc` info VLR, the 32-byte hierarchy
// entry and its -1 page reference. The octree that consumes those pages is
// @voxelkloud/core's, the LAS record is @voxelkloud/format-las's, and the
// laszip decode is @voxelkloud/wasm-codecs's — because none of the three is
// COPC's alone.

export { COPC_FORMAT_ID, copcFormat } from "./format.js";
export { loadCopcSource } from "./load.js";
export { openCopcTree, parseHierarchyPage } from "./hierarchy.js";
export type { OpenCopcTreeOptions } from "./hierarchy.js";
export { openCopcPoints } from "./points-reader.js";
export type { CopcPointReader } from "./points-reader.js";
export { DecodePool, decodeWorkersAvailable } from "./decode-pool.js";
export type { DecodePoolOptions } from "./decode-pool.js";
export {
  COPC_ENTRY_SIZE,
  COPC_HIERARCHY_RECORD_ID,
  COPC_INFO_RECORD_ID,
  COPC_INFO_SIZE,
  COPC_USER_ID,
  copcCube,
  parseCopcInfo,
} from "./copc-info.js";
export type { CopcInfo } from "./copc-info.js";
export type {
  CopcNodePayload,
  CopcPageRef,
  CopcSource,
  CopcWarning,
  CopcWarningCode,
} from "./types.js";
