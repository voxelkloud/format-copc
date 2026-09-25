// A COPC node's payload, decoded off the main thread.
//
// WHY THIS EXISTS, with the measurement. `LazChunkDecoder.decode` is a
// synchronous wasm call, and on the point format 6/7/8 records that modern
// survey output uses it runs at roughly 0.5 million points a second — a 100k
// node is ~190 ms. The view keeps twelve fetches in flight, so a burst of
// completions lands several of those in ONE frame, on the thread that is also
// supposed to be drawing and handling the pointer. Filling a 3M point budget
// costs about six seconds of blocked main thread, delivered in 50-200 ms
// chunks. That is the jank, and it is the whole reason this file exists.
//
// WHAT CROSSES BACK is a finished `DecodedPointData`: one typed array per
// attribute, TRANSFERRED rather than copied. `@voxelkloud/core` shaped that
// type for exactly this hop — `transferList` is precomputed there and has been
// since before any worker existed to use it.
//
// The whole record walk happens here too, not just the wasm call. Splitting
// them would leave ~0.12 us/point of DataView loops on the main thread for no
// reason: the walk's output is what we want to transfer anyway.

/// <reference lib="webworker" />

import { decodeLasRecords } from "@voxelkloud/format-las";
import type { LasDecodePlan } from "@voxelkloud/format-las";
import { LazChunkDecoder, initLazCodec } from "@voxelkloud/wasm-codecs";
import type { DecodedPointData, PointNodeRef } from "@voxelkloud/core";

/**
 * The slice of a node the decoder reads.
 *
 * A structured clone of the real node would drag the whole octree across —
 * tree nodes are cyclic through `parent`, which is the reason
 * `@voxelkloud/core` declares the flat `PointNodeRef` at all — so only these
 * nine values travel. `decodeLasRecords` stamps `index` and `name` onto the
 * result, reads `numPoints` to size everything, and reads the box for the
 * `"node"` origin policy and for the float32 precision warning.
 */
export interface WorkerNodeRef {
  readonly index: number;
  readonly name: string;
  readonly numPoints: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** Sent once per worker, before any decode. */
export interface InitRequest {
  readonly kind: "init";
  /** Payload of the `laszip encoded` VLR — the whole file's, not a node's. */
  readonly laszipRecord: ArrayBuffer;
  /**
   * The plan, cloned.
   *
   * Structured clone preserves internal aliasing, so `plan.position` and
   * `plan.color.field` still point AT entries of `plan.fields` on the far
   * side rather than at copies of them. The decoder relies on that identity in
   * no way, but nothing has to be rebuilt either.
   */
  readonly plan: LasDecodePlan;
}

export interface DecodeRequest {
  readonly kind: "decode";
  readonly id: number;
  /** The node's compressed chunk, transferred in. */
  readonly chunk: ArrayBuffer;
  readonly node: WorkerNodeRef;
  readonly computeBounds: boolean;
  /** Field mask; see `lazSelectionForAttributes`. */
  readonly selection: number;
}

export type WorkerRequest = InitRequest | DecodeRequest;

export interface ReadyMessage {
  readonly kind: "ready";
}

export interface DoneMessage {
  readonly kind: "done";
  readonly id: number;
  readonly data: DecodedPointData;
}

export interface ErrorMessage {
  readonly kind: "error";
  /** Absent when the failure was the init, which has no request to blame. */
  readonly id: number | undefined;
  readonly message: string;
}

export type WorkerMessage = ReadyMessage | DoneMessage | ErrorMessage;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

let decoder: LazChunkDecoder | undefined;
let plan: LasDecodePlan | undefined;

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.kind === "init") {
    void (async () => {
      try {
        await initLazCodec();
        decoder = new LazChunkDecoder(new Uint8Array(request.laszipRecord));
        plan = request.plan;
        const ready: ReadyMessage = { kind: "ready" };
        scope.postMessage(ready);
      } catch (error) {
        fail(undefined, error);
      }
    })();
    return;
  }

  if (decoder === undefined || plan === undefined) {
    fail(request.id, new Error("This decode worker was never initialised."));
    return;
  }

  try {
    const records = decoder.decodeSelective(
      new Uint8Array(request.chunk),
      request.node.numPoints,
      request.selection,
    );
    const data = decodeLasRecords(
      plan,
      request.node as unknown as PointNodeRef,
      records,
      { computeBounds: request.computeBounds },
    );
    const done: DoneMessage = { kind: "done", id: request.id, data };
    // `transferList` is every DISTINCT buffer the decode produced, which is
    // what makes this hop cost a pointer move per attribute rather than a copy
    // of the node. Anything omitted here would be cloned instead — correct, but
    // it would hand the copy cost straight back to the main thread.
    scope.postMessage(done, data.transferList as unknown as Transferable[]);
  } catch (error) {
    fail(request.id, error);
  }
});

/**
 * Report a failure as a message rather than as an unhandled rejection.
 *
 * A throw inside the worker surfaces on the page as an `error` event with no
 * request attached, so the pool could only fail EVERY pending decode. Naming
 * the id keeps one bad node from poisoning its neighbours — which matters
 * because the view's retry policy is per node.
 */
function fail(id: number | undefined, error: unknown): void {
  const message: ErrorMessage = {
    kind: "error",
    id,
    message: error instanceof Error ? error.message : String(error),
  };
  scope.postMessage(message);
}
