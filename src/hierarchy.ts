// COPC hierarchy pages.
//
// A page is a flat run of 32-byte entries, each a key plus an offset, a byte
// size and a point count. A count of -1 marks the entry as a REFERENCE: the
// subtree at that key, the node itself included, is described in another page
// at that offset. Which is the paged-octree model core already owns, so this
// file is a parser and nothing else — the tree, the dedupe and the backoff come
// from `createPagedOctree`.

import { VoxelkloudError, createPagedOctree } from "@voxelkloud/core";
import type { OctreePage, PagedOctree } from "@voxelkloud/core";
import { COPC_ENTRY_SIZE } from "./copc-info.js";
import { fetchRange } from "./range.js";
import type { CopcNodePayload, CopcPageRef, CopcSource } from "./types.js";

/**
 * Parse one page.
 *
 * @param at Where the page came from, for error messages.
 * @throws {VoxelkloudError} `"hierarchy-error"` when the page is not a whole
 *   number of entries, or an entry's own numbers do not add up.
 */
export function parseHierarchyPage(
  bytes: Uint8Array,
  at: string,
): OctreePage<CopcNodePayload, CopcPageRef> {
  if (bytes.byteLength % COPC_ENTRY_SIZE !== 0) {
    throw new VoxelkloudError(
      "hierarchy-error",
      `COPC hierarchy page at ${at} is ${bytes.byteLength} bytes, not a whole ` +
        `number of ${COPC_ENTRY_SIZE}-byte entries.`,
      { path: at },
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodes: OctreePage<CopcNodePayload, CopcPageRef>["nodes"][number][] = [];
  const links: OctreePage<CopcNodePayload, CopcPageRef>["links"][number][] = [];

  for (let i = 0; i * COPC_ENTRY_SIZE < bytes.byteLength; i++) {
    const base = i * COPC_ENTRY_SIZE;
    const level = view.getInt32(base, true);
    const x = view.getInt32(base + 4, true);
    const y = view.getInt32(base + 8, true);
    const z = view.getInt32(base + 12, true);
    const offset = Number(view.getBigUint64(base + 16, true));
    const byteSize = view.getInt32(base + 24, true);
    const pointCount = view.getInt32(base + 28, true);

    if (!Number.isSafeInteger(offset) || offset < 0 || byteSize < 0) {
      throw new VoxelkloudError(
        "hierarchy-error",
        `COPC hierarchy entry ${at}#${i} (${level}-${x}-${y}-${z}) points at ` +
          `offset ${offset} for ${byteSize} bytes, which cannot be read.`,
        { path: `${at}#${i}` },
      );
    }

    if (pointCount === -1) {
      if (byteSize === 0) {
        throw new VoxelkloudError(
          "hierarchy-error",
          `COPC hierarchy entry ${at}#${i} (${level}-${x}-${y}-${z}) is a page ` +
            `reference with a zero byte size, so the page it names is empty.`,
          { path: `${at}#${i}` },
        );
      }
      links.push({ level, x, y, z, ref: { offset, byteSize } });
      continue;
    }
    if (pointCount < 0) {
      throw new VoxelkloudError(
        "hierarchy-error",
        `COPC hierarchy entry ${at}#${i} (${level}-${x}-${y}-${z}) declares ` +
          `${pointCount} points. Only -1 has a meaning below zero.`,
        { path: `${at}#${i}` },
      );
    }
    // `byteSize === 0` with a real point count is how COPC spells an empty
    // node: it exists in the tree, it has no chunk. Kept, so the subtree under
    // it stays reachable.
    nodes.push({ level, x, y, z, pointCount, payload: { offset, byteSize } });
  }

  return { nodes, links };
}

export interface OpenCopcTreeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxNodes?: number | undefined;
  readonly maxConcurrentPageRequests?: number | undefined;
}

/**
 * Open the LOD tree over a COPC file, with the root page already loaded.
 *
 * The root page is awaited rather than left lazy because a caller that has a
 * tree object and cannot draw anything from it has nothing useful — and it is
 * one ranged GET.
 */
export async function openCopcTree(
  source: CopcSource,
  options: OpenCopcTreeOptions = {},
): Promise<PagedOctree<CopcNodePayload>> {
  const tree = createPagedOctree<CopcNodePayload, CopcPageRef>({
    bounds: source.bounds,
    rootPage: {
      offset: source.copc.rootHierarchyOffset,
      byteSize: source.copc.rootHierarchySize,
    },
    loadPage: async (ref, signal) => {
      const bytes = await fetchRange(
        source.transport,
        source.url,
        ref.offset,
        ref.byteSize,
        signal,
      );
      return parseHierarchyPage(bytes, `${source.url}@${ref.offset}`);
    },
    // An octree's refinement quantum IS its point pitch, so these agree. They
    // stay separate methods because a format whose quantum is not a pitch has
    // to be able to override one without corrupting the other.
    geometricErrorAt: (level) => source.copc.spacing / 2 ** level,
    pointSpacingAt: (level) => source.copc.spacing / 2 ** level,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    ...(options.maxConcurrentPageRequests !== undefined
      ? { maxConcurrentPageRequests: options.maxConcurrentPageRequests }
      : {}),
  });

  await tree.expand(
    tree.root,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return tree;
}
