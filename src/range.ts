// All HTTP for a COPC file. INTERNAL.
//
// One file holds the header, the VLRs, every node's points and the hierarchy,
// so every request here is a byte range into the same URL. That is the whole
// premise of the format — and it means a host that does not honour `Range` can
// serve a valid COPC file that no client can read, which is why the triage
// below distinguishes "the file is wrong" from "the host is misconfigured".

import { VoxelkloudError } from "@voxelkloud/core";
import type { PointCloudTransport } from "@voxelkloud/core";

/**
 * The most a whole-file fallback may cost.
 *
 * A host that ignores `Range` still serves a small COPC usefully, and refusing
 * one over pedantry would be worse than slicing it. At some size that stops
 * being true — a 2 GB file fetched in full for every node is not a degraded
 * mode, it is a hang — and 64 MiB is where the line goes.
 */
const MAX_WHOLE_FILE_BYTES = 64 * 1024 * 1024;

export function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function initFor(
  transport: PointCloudTransport,
  range: string | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  // Merge via `Headers` so the Headers, array and record forms all work — the
  // contract documented on `PointCloudTransport.requestInit`.
  const headers = new Headers(transport.requestInit?.headers);
  if (range !== undefined) headers.set("Range", range);
  return { ...transport.requestInit, headers, signal };
}

async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` Body starts: ${JSON.stringify(text.slice(0, 200))}` : "";
  } catch {
    return "";
  }
}

/**
 * Read `[offset, offset + length)` of a file.
 *
 * A server that ignores `Range` and answers 200 with the whole file is
 * ACCEPTED and sliced, because a COPC file is commonly small enough for that to
 * work and the alternative is refusing a file that is perfectly good. A 200
 * whose body does not even reach the requested range is not recoverable and
 * says so.
 */
export async function fetchRange(
  transport: PointCloudTransport,
  url: string,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  // `bytes=X-(X-1)` is a range RFC 9110 says an origin IGNORES, answering 200
  // with the entire file. Never emit one.
  const range = `bytes=${offset}-${offset + length - 1}`;

  let res: Response;
  try {
    res = await transport.fetch(url, initFor(transport, range, signal));
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new VoxelkloudError("network-error", `Network error fetching ${range} of ${url}.`, {
      url,
      cause,
    });
  }

  if (res.status === 416) {
    throw new VoxelkloudError(
      "hierarchy-error",
      `${url} is shorter than its own offsets claim: the server rejected ` +
        `${range} as unsatisfiable.`,
      { url, status: 416 },
    );
  }
  if (!res.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${range} of ${url} failed: HTTP ${res.status} ${res.statusText}.` +
        (await bodySnippet(res)),
      { url, status: res.status },
    );
  }

  if (res.status === 200) {
    // The server ignored Range and is about to hand over the WHOLE file. That
    // is survivable for a small COPC and catastrophic for a large one: reading
    // the body first and checking afterwards downloads two gigabytes to serve a
    // 40 KB node. So the declared length decides BEFORE the body is touched.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WHOLE_FILE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new VoxelkloudError(
        "range-request-unsupported",
        `${url} answered 200 to ${range}, offering all ${declared} bytes. This ` +
          `host does not honour Range requests, and a COPC file is only ` +
          `streamable if it does — every node lives at an offset inside it. ` +
          `Serving ${(declared / 1e6).toFixed(0)} MB per node is not a fallback.`,
        { url, status: 200 },
      );
    }
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.byteLength > MAX_WHOLE_FILE_BYTES) {
      throw new VoxelkloudError(
        "range-request-unsupported",
        `${url} answered 200 to ${range} with ${whole.byteLength} bytes and no ` +
          `usable content-length. The host must honour Range requests.`,
        { url, status: 200 },
      );
    }
    if (whole.byteLength >= offset + length) {
      return whole.subarray(offset, offset + length);
    }
    throw new VoxelkloudError(
      "range-request-unsupported",
      `${url} answered 200 to a Range request with ${whole.byteLength} bytes, ` +
        `which does not cover ${range}. The host must honour Range requests to ` +
        `stream a COPC file — every node lives at an offset inside it.`,
      { url, status: 200 },
    );
  }

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 206) {
    throw new VoxelkloudError(
      "hierarchy-error",
      `${url} answered HTTP ${res.status} to ${range}; expected 206 or 200.`,
      { url, status: res.status },
    );
  }
  if (buffer.byteLength !== length) {
    throw new VoxelkloudError(
      "range-request-unsupported",
      `${url} answered 206 to ${range} with ${buffer.byteLength} bytes instead ` +
        `of ${length}. The host's Range support is broken.`,
      { url, status: 206 },
    );
  }
  return buffer;
}
