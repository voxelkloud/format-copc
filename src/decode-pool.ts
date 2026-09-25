// The page's half of the decode workers: a small pool, one wasm decoder each.
//
// A POOL AND NOT A WORKER PER NODE, which is the opposite of what
// `@voxelkloud/format-single` does, and for a reason that is worth stating.
// That tier builds ONE file once, peaks at gigabytes, and wants the heap handed
// back afterwards — so it spawns, builds and terminates. This one decodes
// thousands of small nodes over the life of a view, and each worker has to
// parse the laszip VLR and instantiate the wasm before it can decode anything.
// Paying that per node would cost more than the decode.
//
// THE POOL IS PER READER, not global: the decoder is built from one file's
// laszip VLR, so two clouds cannot share a worker. A view with two COPC layers
// gets two pools, which is the honest cost of the format.

import { VoxelkloudError } from "@voxelkloud/core";
import type { DecodedPointData } from "@voxelkloud/core";
import type { LasDecodePlan } from "@voxelkloud/format-las";
import type {
  DecodeRequest,
  InitRequest,
  WorkerMessage,
  WorkerNodeRef,
} from "./decode-worker.js";

/**
 * Workers to run, by default.
 *
 * Four, and it is a ceiling rather than a target. The view keeps twelve fetches
 * in flight but decode is CPU-bound, so beyond the core count the queue only
 * moves from the pool into the scheduler; and every worker holds its own wasm
 * instance plus whatever node it is decoding, which is real memory on a device
 * that may not have much. `hardwareConcurrency - 1` leaves the main thread a
 * core to draw with.
 */
function defaultWorkerCount(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores - 1));
}

export interface DecodePoolOptions {
  readonly laszipRecord: Uint8Array;
  readonly plan: LasDecodePlan;
  /** Overrides the default of `min(4, hardwareConcurrency - 1)`. */
  readonly workers?: number;
}

interface Pending {
  readonly resolve: (data: DecodedPointData) => void;
  readonly reject: (error: unknown) => void;
  readonly worker: Entry;
  /** Set when the caller aborted; the result is dropped when it lands. */
  abandoned: boolean;
}

interface Entry {
  readonly worker: Worker;
  /** Requests dispatched to this worker and not yet answered. */
  inFlight: number;
}

/** Whether a decode can run off the main thread in this environment. */
export function decodeWorkersAvailable(): boolean {
  return typeof Worker !== "undefined";
}

/**
 * A pool of decode workers that degrades to nothing.
 *
 * EVERY failure path ends in `broken`, and a broken pool reports `available`
 * as false rather than throwing. The caller — `openCopcPoints` — then decodes
 * on the main thread exactly as it did before this file existed. That is the
 * only responsible shape for this: a worker can fail to start for reasons the
 * library cannot see or fix (a bundler that did not emit the chunk, a Content
 * Security Policy with no `worker-src`, a browser in a context where module
 * workers are unavailable), and none of them should turn a viewer that is
 * merely slow into one that shows nothing.
 *
 * BUNDLERS. The worker is reached through `new URL("./decode-worker.js",
 * import.meta.url)`, which Rollup, webpack 5, esbuild's bundler and Vite's
 * production build all rewrite to the emitted chunk — verified against a Vite
 * production build, which emits `decode-worker-*.js` beside the wasm. Vite's
 * DEV server pre-bundles dependencies with esbuild's transform pipeline, which
 * does not rewrite it; there the pool finds no worker and falls back. That is
 * the same pre-bundling that already breaks `@voxelkloud/wasm-codecs`'s own
 * wasm URL, so the fix is the one such a consumer already needs:
 *
 * ```js
 * // vite.config.js
 * optimizeDeps: { exclude: ["@voxelkloud/wasm-codecs", "@voxelkloud/format-copc"] }
 * ```
 *
 * With that in place a dev server starts the workers exactly as the production
 * build does. Nothing here requires it that did not already.
 */
export class DecodePool {
  private readonly entries: Entry[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private broken = false;
  private disposed = false;
  /** Resolves once every worker has answered `ready`, or the pool broke. */
  private readonly started: Promise<void>;

  constructor(private readonly options: DecodePoolOptions) {
    if (!decodeWorkersAvailable()) {
      this.broken = true;
      this.started = Promise.resolve();
      return;
    }
    this.started = this.start(options.workers ?? defaultWorkerCount());
  }

  /** False once the pool has broken, or where `Worker` does not exist. */
  get available(): boolean {
    return !this.broken && !this.disposed;
  }

  /** Workers that answered `ready`. Zero means every decode runs inline. */
  get size(): number {
    return this.entries.length;
  }

  /** Awaited once by the caller so the first node does not race the init. */
  ready(): Promise<void> {
    return this.started;
  }

  private async start(count: number): Promise<void> {
    const boots: Promise<Entry | undefined>[] = [];
    for (let i = 0; i < count; i++) boots.push(this.boot());
    const settled = await Promise.all(boots);
    for (const entry of settled) if (entry !== undefined) this.entries.push(entry);
    // Not "some failed" — ALL failed. One worker is enough to be worth using,
    // and a machine that refused the fourth for memory reasons should still get
    // the first three.
    if (this.entries.length === 0) this.broken = true;
  }

  private boot(): Promise<Entry | undefined> {
    return new Promise<Entry | undefined>((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./decode-worker.js", import.meta.url), {
          type: "module",
        });
      } catch {
        resolve(undefined);
        return;
      }
      const entry: Entry = { worker, inFlight: 0 };
      let settled = false;

      worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.kind === "ready") {
          if (settled) return;
          settled = true;
          resolve(entry);
          return;
        }
        // An init failure arrives with no id, and it means this worker will
        // never decode anything.
        if (message.kind === "error" && message.id === undefined) {
          if (!settled) {
            settled = true;
            worker.terminate();
            resolve(undefined);
          }
          return;
        }
        this.settle(message, entry);
      });

      // A worker that cannot load reports here and nowhere else. Without this
      // the boot promise would never settle and the first read would hang.
      worker.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          worker.terminate();
          resolve(undefined);
          return;
        }
        this.breakDown(entry, new Error("A COPC decode worker died."));
      });

      const laszip = this.options.laszipRecord.slice().buffer as ArrayBuffer;
      const init: InitRequest = {
        kind: "init",
        laszipRecord: laszip,
        plan: this.options.plan,
      };
      worker.postMessage(init, [laszip]);
    });
  }

  private settle(message: WorkerMessage, entry: Entry): void {
    if (message.kind === "ready") return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    const id = message.id;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (pending.abandoned) return;
    if (message.kind === "done") pending.resolve(message.data);
    else pending.reject(new VoxelkloudError("unsupported-point-data", message.message));
  }

  /** Fail every outstanding request on a worker that died mid-flight. */
  private breakDown(entry: Entry, error: Error): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
    if (this.entries.length === 0) this.broken = true;
    for (const [id, pending] of [...this.pending]) {
      if (pending.worker !== entry) continue;
      this.pending.delete(id);
      if (!pending.abandoned) pending.reject(error);
    }
  }

  /**
   * Decode one node off the main thread.
   *
   * `chunk` is TRANSFERRED: the caller fetched it and has no use for it
   * afterwards, and a copy of a multi-megabyte chunk on the way out would hand
   * back a slice of the cost this whole file exists to remove. The buffer is
   * detached on this side the moment `postMessage` returns.
   *
   * ABORT DROPS THE RESULT, it does not stop the work. There is no way to
   * interrupt a synchronous wasm call short of terminating the worker, and
   * terminating it would throw away the decoder and the wasm instance to save
   * the tail of one node. The request is marked instead, and the reply is
   * discarded when it lands.
   */
  decode(
    chunk: Uint8Array,
    node: WorkerNodeRef,
    selection: number,
    computeBounds: boolean,
    signal?: AbortSignal,
  ): Promise<DecodedPointData> {
    const entry = this.leastBusy();
    if (entry === undefined) {
      return Promise.reject(
        new VoxelkloudError(
          "unsupported-point-data",
          "No COPC decode worker is available.",
        ),
      );
    }

    const id = this.nextId++;
    return new Promise<DecodedPointData>((resolve, reject) => {
      const pending: Pending = { resolve, reject, worker: entry, abandoned: false };
      this.pending.set(id, pending);

      if (signal !== undefined) {
        const onAbort = (): void => {
          pending.abandoned = true;
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("The node read was aborted.", "AbortError"),
          );
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // The whole backing store only when the view IS the whole backing store;
      // otherwise a copy of exactly this chunk. Handing over `chunk.buffer` for
      // a view into something bigger would detach the neighbours too.
      const whole =
        chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength;
      const buffer = (whole ? chunk.buffer : chunk.slice().buffer) as ArrayBuffer;
      const request: DecodeRequest = {
        kind: "decode",
        id,
        chunk: buffer,
        node,
        computeBounds,
        selection,
      };
      entry.inFlight++;
      entry.worker.postMessage(request, [buffer]);
    });
  }

  /**
   * The worker with the shortest queue.
   *
   * Least-busy rather than round-robin because node sizes vary by more than an
   * order of magnitude within one cloud — a root node and a leaf differ by 20x
   * — so a rotation lands four small nodes behind one large one often enough
   * to matter.
   */
  private leastBusy(): Entry | undefined {
    let best: Entry | undefined;
    for (const entry of this.entries) {
      if (best === undefined || entry.inFlight < best.inFlight) best = entry;
    }
    return best;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) entry.worker.terminate();
    this.entries.length = 0;
    for (const [, pending] of this.pending) pending.abandoned = true;
    this.pending.clear();
  }
}
