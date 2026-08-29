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
 * Whether a 206 shorter than the request is an error.
 *
 * For a range derived from the file's OWN offsets it is: the file is shorter
 * than it claims to be, and reading a node's points from it would hand a
 * truncated buffer to the decoder. For a speculative read — "the first 8 KiB,
 * however much that turns out to be" — it is not an error at all; see
 * {@link fetchHead}.
 */
type ShortRead = "reject" | "accept-at-eof";

/**
 * The end of the file, per `Content-Range`, or `undefined` if it did not say.
 *
 * The header reads `bytes <first>-<last>/<total>`, and `total` may be `*` when
 * the origin does not know it. Without a total there is no way to tell a file
 * that ended from a host that truncates, and this returns `undefined` rather
 * than guessing — the caller then treats the short read as the error it might
 * be.
 */
function eofFrom(res: Response): { last: number; total: number } | undefined {
  const raw = res.headers.get("content-range");
  if (raw === null) return undefined;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(raw.trim());
  if (m === null) return undefined;
  const last = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isFinite(last) || !Number.isFinite(total)) return undefined;
  return { last, total };
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
  shortRead: ShortRead = "reject",
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
    // O MESMO caso do 206 curto, pela outra porta: um host que ignora `Range`
    // devolve o arquivo inteiro, e o arquivo inteiro é menor que a sondagem.
    // Aqui não é preciso `Content-Range` para o provar — este corpo É o arquivo.
    if (shortRead === "accept-at-eof" && offset < whole.byteLength) {
      return whole.subarray(offset);
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
    /*
     * A SHORT 206 IS NOT AUTOMATICALLY A BROKEN HOST.
     *
     * RFC 9110 says a range whose end runs past the file is satisfied by what
     * exists: asked for `bytes=0-8191` of a 1410-byte file, a CORRECT server
     * answers 206 with 1410 bytes and `Content-Range: bytes 0-1409/1410`.
     * Treating that as broken made every COPC smaller than the 8 KiB head probe
     * unreadable — and because one failed layer rejects the whole `Promise.all`
     * that loads a project, a single tiny tile made the entire project
     * impossible to open. Measured on the Garopaba TLS: three of six blocks are
     * under 8 KiB, and they took the other three and the aerial survey with them.
     *
     * The proof required is the origin's own `Content-Range`. Without it — a
     * missing header, or a `*` total — there is no way to separate a file that
     * ended from a host that truncates, and the error below stands.
     */
    const eof = eofFrom(res);
    const reached = eof !== undefined && eof.last === eof.total - 1;
    const exact = eof !== undefined && buffer.byteLength === eof.last - offset + 1;
    if (shortRead === "accept-at-eof" && reached && exact) return buffer;
    throw new VoxelkloudError(
      "range-request-unsupported",
      `${url} answered 206 to ${range} with ${buffer.byteLength} bytes instead ` +
        `of ${length}. The host's Range support is broken.`,
      { url, status: 206 },
    );
  }
  return buffer;
}

/**
 * The first `atMost` bytes of a file, or all of it when it is smaller.
 *
 * A DIFFERENT QUESTION from {@link fetchRange}, which is why it has its own
 * name. The head probe does not know how much of the file it needs — it guesses
 * a size that covers the header and the VLR directory of almost every COPC, and
 * reads again when the guess was short. "However much of the first 8 KiB
 * exists" is a well-formed request; "the 8192 bytes at offset 0" is not, for a
 * file with 1410 of them.
 *
 * Keeping this separate is what lets a short read stay an ERROR everywhere
 * else: a node's byte range comes from the file's own offsets, and getting less
 * than it asked for there means the file is truncated, not small.
 */
export function fetchHead(
  transport: PointCloudTransport,
  url: string,
  atMost: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  return fetchRange(transport, url, 0, atMost, signal, "accept-at-eof");
}
