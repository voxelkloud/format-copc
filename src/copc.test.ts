// Against a real COPC file, or not at all.
//
// `demo/potree/pointclouds/lion_takanawa.copc.laz` came out of `untwine`, and
// it is the only oracle worth having here: a hand-built COPC fixture would be
// this driver's own idea of the format, checked against itself. The file is
// gitignored, so every test skips when it is absent and says so.

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { FetchLike, PagedOctreeNode } from "@voxelkloud/core";
import { copcFormat } from "./format.js";
import { loadCopcSource } from "./load.js";
import { openCopcTree } from "./hierarchy.js";
import { openCopcPoints } from "./points-reader.js";
import { fetchRange } from "./range.js";
import { decodeLasRecords } from "@voxelkloud/format-las";
import { LazChunkDecoder, LazField } from "@voxelkloud/wasm-codecs";
import type { CopcNodePayload, CopcSource } from "./types.js";

const FILE = new URL(
  "../../../demo/potree/pointclouds/lion_takanawa.copc.laz",
  import.meta.url,
);
const PATH = fileURLToPath(FILE);
const HAS_FILE = existsSync(PATH);
if (!HAS_FILE) {
  console.warn(
    "@voxelkloud/format-copc: demo/potree/pointclouds/lion_takanawa.copc.laz " +
      "is missing, so the driver tests are skipped. Fetch it with " +
      "demo/data/fetch-large.sh.",
  );
}

const URL_UNDER_TEST = "https://example.test/lion_takanawa.copc.laz";

/** Counts what the driver actually asks for, which is half of what is tested. */
interface Server {
  readonly fetch: FetchLike;
  readonly requests: { range: string | null; bytes: number }[];
}

/**
 * A local file served over `Range`, because `fetch` cannot open a `file:` URL
 * and the premise of this driver is that it never reads a whole one.
 */
function serve(path: string): Server {
  const bytes = new Uint8Array(readFileSync(path));
  const requests: { range: string | null; bytes: number }[] = [];
  const fetchLike: FetchLike = async (_input, init) => {
    const range = new Headers(init?.headers).get("Range");
    if (range === null) {
      requests.push({ range, bytes: bytes.byteLength });
      return new Response(bytes, { status: 200 });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m === null) return new Response(null, { status: 416 });
    const from = Number(m[1]);
    const to = Math.min(Number(m[2]), bytes.byteLength - 1);
    if (from >= bytes.byteLength) return new Response(null, { status: 416 });
    const slice = bytes.subarray(from, to + 1);
    requests.push({ range, bytes: slice.byteLength });
    return new Response(slice, {
      status: 206,
      headers: { "content-range": `bytes ${from}-${to}/${bytes.byteLength}` },
    });
  };
  return { fetch: fetchLike, requests };
}

let source: CopcSource;
let server: Server;

beforeAll(async () => {
  if (!HAS_FILE) return;
  server = serve(PATH);
  source = await loadCopcSource(URL_UNDER_TEST, { fetch: server.fetch });
});

describe.skipIf(!HAS_FILE)("loadCopcSource", () => {
  it("opens the file with one ranged read of its head", () => {
    // The whole premise: a 2.7 MB file is identified and fully described
    // without fetching 2.7 MB.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.range).toBe("bytes=0-8191");
    expect(server.requests[0]!.bytes).toBe(8192);
    expect(statSync(PATH).size).toBeGreaterThan(2_000_000);
  });

  it("reads the header and the copc VLR", () => {
    expect(source.pointFormat).toBe(7);
    expect(source.pointSize).toBe(40);
    expect(source.pointCount).toBe(341_989);
    expect(source.scale).toEqual([0.01, 0.01, 0.01]);
    expect(source.copc.spacing).toBeGreaterThan(0);
    expect(source.copc.rootHierarchyOffset).toBeGreaterThan(0);
    // One warning, and it is the file's: every gps-time in it is 0, so the
    // f32 lane has a range of zero to normalise against. Saying so beats
    // silently dividing by it.
    expect(source.warnings.map((w) => w.code)).toEqual(["degenerate-range"]);
    expect(source.warnings[0]!.path).toBe("gps-time");
  });

  it("separates the indexing cube from the data extent", () => {
    // `bounds` is the cube the octree subdivides and `tightBoundingBox` is
    // where the points are. Conflating them is what makes a camera fit-to-view
    // frame empty space.
    const cube = source.bounds;
    const tight = source.tightBoundingBox;
    for (let axis = 0; axis < 3; axis++) {
      expect(cube.max[axis]! - cube.min[axis]!).toBeCloseTo(
        source.copc.halfSize * 2,
        9,
      );
      expect(tight.min[axis]!).toBeGreaterThanOrEqual(cube.min[axis]! - 0.01);
      expect(tight.max[axis]!).toBeLessThanOrEqual(cube.max[axis]! + 0.01);
    }
    // The cube really is bigger than the data on at least one axis here, so the
    // two are not accidentally equal.
    expect(cube.max[2]! - cube.min[2]!).toBeGreaterThan(
      tight.max[2]! - tight.min[2]!,
    );
  });

  it("names its attributes the way PotreeConverter does", () => {
    // The same LiDAR through two drivers must expose the same names, or a
    // colour mode stops working when the format changes.
    const names = source.attributes.map((a) => a.name);
    expect(names).toContain("position");
    expect(names).toContain("intensity");
    expect(names).toContain("classification");
    expect(names).toContain("gps-time");
    expect(names).toContain("rgb");
    // The bit-packed fields come apart, as they do in a Potree manifest.
    expect(names).toContain("return number");
    expect(names).toContain("number of returns");
    expect(names).toContain("classification flags");
    // The Extra Bytes VLR carries this one; without parsing it, four bytes of
    // every record would be unreadable.
    expect(names).toContain("OriginId");

    const position = source.attributesByName.get("position")!;
    expect(position.role).toBe("position");
    expect(position.type).toBe("int32");
    expect(position.numElements).toBe(3);
    expect(source.attributesByName.get("rgb")!.role).toBe("color");
    expect(source.attributesByName.get("OriginId")!.type).toBe("uint32");
  });

  it("takes the gps-time domain from the copc VLR", () => {
    // Nothing else in a LAS file declares it, and without a domain the f32 lane
    // normalises against a range of zero and every point decodes to 0.
    const gps = source.attributesByName.get("gps-time")!;
    expect(gps.min[0]).toBe(source.copc.gpsTimeRange[0]);
    expect(gps.max[0]).toBe(source.copc.gpsTimeRange[1]);
  });

  it("refuses a LAS file that is not COPC, and names the fix", async () => {
    // A plain LAZ node from the EPT build of the same cloud: valid LAS, no
    // `copc` VLR.
    const plain = new URL(
      "../../../demo/potree/pointclouds/lion_takanawa_ept_laz/ept-data/0-0-0-0.laz",
      import.meta.url,
    );
    if (!existsSync(fileURLToPath(plain))) return;
    const s = serve(fileURLToPath(plain));
    await expect(
      loadCopcSource("https://example.test/plain.laz", { fetch: s.fetch }),
    ).rejects.toThrow(/copc. VLR/);
  });
});

describe.skipIf(!HAS_FILE)("openCopcTree", () => {
  it("loads the root page and nothing else", async () => {
    const before = server.requests.length;
    const tree = await openCopcTree(source);
    expect(server.requests.length - before).toBe(1);
    expect(tree.root.numPoints).toBeGreaterThan(0);
    expect(tree.root.childMask).toBeDefined();
    expect(tree.nodeCount).toBeGreaterThan(1);
    tree.dispose();
  });

  it("gives every node a box inside its parent, and the layers sum", async () => {
    const tree = await openCopcTree(source);
    await tree.expandAll();
    // This cloud's whole hierarchy is one 288-byte page: a root and its eight
    // children. The multi-page path is exercised in core's own tests, where a
    // page reference can be constructed rather than waited for.
    expect(tree.nodeCount).toBe(9);
    expect(tree.maxLevel).toBe(1);

    let counted = 0;
    for (let i = 1; i < tree.nodeCount; i++) {
      const node = tree.node(i)!;
      const parent = node.parent!;
      expect(node.minX).toBeGreaterThanOrEqual(parent.minX);
      expect(node.maxX).toBeLessThanOrEqual(parent.maxX);
      expect(node.minZ).toBeGreaterThanOrEqual(parent.minZ);
      expect(node.maxZ).toBeLessThanOrEqual(parent.maxZ);
      expect(node.level).toBe(parent.level + 1);
      counted += node.numPoints;
    }
    // Every point in the file belongs to exactly one node's own layer, so the
    // layers add up to the header's count. A hierarchy read one entry short
    // would not.
    expect(counted + tree.root.numPoints).toBe(source.pointCount);
    tree.dispose();
  });

  it("halves the spacing at each level", async () => {
    const tree = await openCopcTree(source);
    expect(tree.geometricErrorAt(0)).toBe(source.copc.spacing);
    expect(tree.pointSpacingAt(3)).toBeCloseTo(source.copc.spacing / 8, 12);
    tree.dispose();
  });
});

describe.skipIf(!HAS_FILE)("openCopcPoints", () => {
  /**
   * THE GUARD ON THE SELECTIVE PATH, and it is the only test that can catch
   * the way that path fails.
   *
   * `decodeSelective` does not zero what it skips: an unselected field holds
   * the FIRST POINT'S value repeated, because laszip stores that one raw and
   * carries it forward. So a mask that is one bit short of what the plan reads
   * produces a node that is the right size, the right shape, and quietly
   * constant in one dimension — a cloud that is all one colour, or all one
   * class, with nothing thrown and nothing logged. Comparing against the full
   * decode is the only way to see it.
   */
  it("decodes the same bytes selectively as it does in full", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source, { computeBounds: true });
    const root = tree.root as PagedOctreeNode<CopcNodePayload>;

    // The mask must actually be narrower than ALL, or this test passes by
    // proving that two full decodes agree.
    expect(reader.lazSelection).not.toBe(LazField.ALL);

    const selective = await reader.read(root);
    const chunk = await fetchRange(
      source.transport,
      source.url,
      root.payload!.offset,
      root.payload!.byteSize,
      undefined,
    );
    const decoder = new LazChunkDecoder(source.laszipRecord);
    const full = decodeLasRecords(
      reader.plan,
      root,
      decoder.decode(chunk, root.numPoints),
      { computeBounds: true },
    );
    decoder.free();

    expect(selective.numPoints).toBe(full.numPoints);
    expect(Array.from(selective.positions)).toEqual(Array.from(full.positions));
    expect(Array.from(selective.colors!.array)).toEqual(
      Array.from(full.colors!.array),
    );
    expect(selective.bounds).toEqual(full.bounds);
    for (const [name, attribute] of full.attributesByName) {
      const mine = selective.attributesByName.get(name);
      expect(mine, `attribute ${name} is missing`).toBeDefined();
      expect(Array.from(mine!.array), `attribute ${name} differs`).toEqual(
        Array.from(attribute.array),
      );
    }
    tree.dispose();
    reader.dispose?.();
  });

  it("decodes the root node into the neutral shape", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source, { computeBounds: true });
    const root = tree.root as PagedOctreeNode<CopcNodePayload>;

    expect(reader.hasPayload(root)).toBe(true);
    const data = await reader.read(root);

    expect(data.numPoints).toBe(root.numPoints);
    expect(data.positions).toBeInstanceOf(Float32Array);
    expect(data.positions).toHaveLength(3 * root.numPoints);
    expect(data.frame.format).toBe("float32");
    expect(data.frame.originPolicy).toBe("cloud");
    expect(data.frame.origin).toEqual([
      source.bounds.min[0],
      source.bounds.min[1],
      source.bounds.min[2],
    ]);
    // Colour is in the default selection and this file has it.
    expect(data.colors).toBeDefined();
    expect(data.colors!.array).toBeInstanceOf(Uint8Array);
    expect(data.colors!.array).toHaveLength(4 * root.numPoints);
    expect(data.colors!.shift).toBe(8); // declared 16-bit channels
    // Alpha is filled, or a shader binding vec4 renders nothing.
    expect(data.colors!.array[3]).toBe(255);

    // Reconstructed absolute coordinates must land inside the node's own box.
    const { origin } = data.frame;
    for (let i = 0; i < Math.min(root.numPoints, 5000); i++) {
      const x = origin[0] + data.positions[3 * i]!;
      const y = origin[1] + data.positions[3 * i + 1]!;
      const z = origin[2] + data.positions[3 * i + 2]!;
      expect(x).toBeGreaterThanOrEqual(root.minX - 0.02);
      expect(x).toBeLessThanOrEqual(root.maxX + 0.02);
      expect(y).toBeGreaterThanOrEqual(root.minY - 0.02);
      expect(z).toBeLessThanOrEqual(root.maxZ + 0.02);
    }
    expect(data.bounds).toBeDefined();

    reader.dispose();
    tree.dispose();
  });

  it("decodes selected scalars into GPU-bindable lanes", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source, {
      attributes: ["classification", "intensity", "gps-time"],
      scalarFormat: "gpu",
      lanes: { classification: "f32" },
    });
    const data = await reader.read(tree.root);

    const classification = data.attributesByName.get("classification")!;
    expect(classification.array).toBeInstanceOf(Float32Array);
    expect(classification.gpuFormat).toBe("float32");

    const intensity = data.attributesByName.get("intensity")!;
    expect(intensity.array).toBeInstanceOf(Uint32Array);
    expect(intensity.gpuFormat).toBe("uint32");
    // Every GPU lane is bindable: that is the whole point of the mode.
    for (const a of data.attributes) expect(a.gpuFormat).toBeDefined();

    // gps-time is a double, so it comes back normalised against the copc VLR's
    // declared domain, with the inverse carried so the value is recoverable.
    const gps = data.attributesByName.get("gps-time")!;
    expect(gps.array).toBeInstanceOf(Float32Array);
    expect(gps.inverse).toBeDefined();
    expect(reader.packingFor("gps-time")).toBeDefined();
    expect(reader.packingFor("intensity")).toBeUndefined();

    // Naming an attribute deselects colour, which halves the bytes per point.
    expect(data.colors).toBeUndefined();

    reader.dispose();
    tree.dispose();
  });

  it("unpacks the bit-run dimensions", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source, {
      attributes: ["return number", "number of returns", "scanner channel"],
    });
    const data = await reader.read(tree.root);

    const returnNumber = data.attributesByName.get("return number")!;
    const numberOfReturns = data.attributesByName.get("number of returns")!;
    for (let i = 0; i < 1000; i++) {
      // A 4-bit run cannot exceed 15, and a return number cannot exceed the
      // number of returns — which is the check that catches reading the shared
      // byte whole instead of unpacking it.
      expect(returnNumber.array[i]!).toBeGreaterThanOrEqual(1);
      expect(returnNumber.array[i]!).toBeLessThanOrEqual(15);
      expect(returnNumber.array[i]!).toBeLessThanOrEqual(
        numberOfReturns.array[i]!,
      );
    }
    reader.dispose();
    tree.dispose();
  });

  it("emits int32 positions losslessly", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source, { positionFormat: "int32" });
    const data = await reader.read(tree.root);

    expect(data.positions).toBeInstanceOf(Int32Array);
    expect(data.frame.originPolicy).toBe("file");
    expect(data.frame.scale).toEqual([...source.scale]);
    expect(data.frame.maxPositionError).toBe(0);

    // Both formats must describe the same points.
    const float = openCopcPoints(source);
    const other = await float.read(tree.root);
    for (let i = 0; i < 200; i++) {
      const exact = data.positions[3 * i]! * source.scale[0] + source.offset[0];
      const approx = other.frame.origin[0] + other.positions[3 * i]!;
      expect(approx).toBeCloseTo(exact, 3);
    }
    float.dispose();
    reader.dispose();
    tree.dispose();
  });

  it("reads a deep node by ranging into the middle of the file", async () => {
    const tree = await openCopcTree(source);
    await tree.expandAll();
    const deep = [...Array(tree.nodeCount).keys()]
      .map((i) => tree.node(i)!)
      .filter((n) => n.level >= 1 && n.numPoints > 0)
      .at(-1)!;

    const reader = openCopcPoints(source);
    const before = server.requests.length;
    const data = await reader.read(deep);
    expect(server.requests.length - before).toBe(1);
    // The request is a slice out of the middle, not the head of the file.
    expect(server.requests.at(-1)!.range).not.toBe("bytes=0-8191");
    expect(data.numPoints).toBe(deep.numPoints);
    reader.dispose();
    tree.dispose();
  });

  it("refuses to read a node with no chunk of its own", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source);
    // What a placeholder for an unfetched hierarchy page looks like.
    const placeholder = { ...tree.root, payload: undefined, name: "fake" };
    expect(reader.hasPayload(placeholder as never)).toBe(false);
    await expect(reader.read(placeholder as never)).rejects.toThrow(
      /no laszip chunk/,
    );
    reader.dispose();
    tree.dispose();
  });

  it("fails loudly once disposed", async () => {
    const tree = await openCopcTree(source);
    const reader = openCopcPoints(source);
    reader.dispose();
    reader.dispose(); // idempotent
    await expect(reader.read(tree.root)).rejects.toThrow(/disposed/);
    tree.dispose();
  });
});

describe("copcFormat", () => {
  it("claims the double extension outright", () => {
    expect(copcFormat.sniffUrl("https://x.test/a.copc.laz")).toBe(3);
    expect(copcFormat.sniffUrl("https://x.test/a.laz")).toBe(2);
    expect(copcFormat.sniffUrl("https://x.test/a.las")).toBe(2);
    expect(copcFormat.sniffUrl("https://x.test/octree/")).toBe(0);
    expect(copcFormat.sniffUrl("https://x.test/metadata.json")).toBe(0);
  });

  it("probes the file itself, not a sibling document", () => {
    expect(copcFormat.probeUrl("https://x.test/a.copc.laz")).toBe(
      "https://x.test/a.copc.laz",
    );
    expect(copcFormat.probeUrl("https://x.test/octree/")).toBeUndefined();
  });

  it("claims a file only when the copc VLR is actually there", () => {
    // THE TIE THIS SETTLES. A COPC file and an ordinary LAZ are both LAS, both
    // start with `LASF`, and both arrive as a `.laz`. Claiming on the magic
    // alone was decisive enough to stop the search — so a plain LAZ went to
    // this driver, failed in `load`, and the single-file driver that exists to
    // read it never got a look.
    const probe = (bytes: Uint8Array | undefined) =>
      copcFormat.sniff({
        url: "https://x.test/a.laz",
        json: undefined,
        head: "",
        bytes,
        contentType: undefined,
      });

    expect(probe(lasBytes({ userId: "copc", recordId: 1 }))).toBe(3);
    // Valid LAS, valid LAZ, no copc VLR: not ours.
    expect(probe(lasBytes({ userId: "laszip encoded", recordId: 22204 }))).toBe(0);
    // A file with no VLRs at all.
    expect(probe(lasBytes({ vlrCount: 0 }))).toBe(0);
    // Not LAS.
    expect(probe(new TextEncoder().encode("{\"version\":\"2.0\"}"))).toBe(0);
    expect(probe(new Uint8Array(0))).toBe(0);
    expect(probe(undefined)).toBe(0);
  });

  it("reads the real file's first VLR as copc", () => {
    if (!HAS_FILE) return;
    const head = new Uint8Array(readFileSync(PATH)).subarray(0, 4096);
    expect(
      copcFormat.sniff({
        url: "https://x.test/a.copc.laz",
        json: undefined,
        head: "",
        bytes: head,
        contentType: undefined,
      }),
    ).toBe(3);
  });
});

describe("a host that ignores Range", () => {
  /** Serves the whole body whatever range is asked for. */
  function ignoresRange(bytes: Uint8Array, declaredLength?: number): FetchLike {
    return async () =>
      // `bytes.buffer` rather than `bytes`: a `Uint8Array<ArrayBufferLike>` is
      // not assignable to `BodyInit` under the DOM lib, and the buffer is.
      new Response(bytes.buffer as ArrayBuffer, {
        status: 200,
        headers:
          declaredLength === undefined
            ? {}
            : { "content-length": String(declaredLength) },
      });
  }

  it("slices a small file rather than refusing it", async () => {
    if (!HAS_FILE) return;
    // A 2.7 MB COPC over a host with no Range support still works. Refusing it
    // would be pedantry.
    const bytes = new Uint8Array(readFileSync(PATH));
    const s = await loadCopcSource(URL_UNDER_TEST, { fetch: ignoresRange(bytes) });
    expect(s.pointCount).toBe(341_989);
  });

  it("refuses before reading the body when the file is large", async () => {
    // THE BUG THIS PINS. Reading the body first and checking afterwards
    // downloads the whole file to serve one node — on a 2 GB COPC that is not a
    // degraded mode, it is a hang. The declared length has to decide first.
    let served = 0;
    const fetchLike: FetchLike = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          served += 1024 * 1024;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(2_029_696_615) },
      });
    };
    await expect(
      loadCopcSource("https://example.test/huge.copc.laz", { fetch: fetchLike }),
    ).rejects.toThrow(/does not honour Range/);
    // A stream hands over whatever it had buffered before the cancel lands, so
    // this is not zero. What it must not be is 2 GB.
    expect(served).toBeLessThan(16 * 1024 * 1024);
  });
});

/** A LAS header with one VLR, enough for the sniff to walk. */
function lasBytes(
  options: { userId?: string; recordId?: number; vlrCount?: number } = {},
): Uint8Array {
  const headerSize = 375;
  const bytes = new Uint8Array(headerSize + 54);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("LASF"), 0);
  view.setUint16(94, headerSize, true);
  view.setUint32(100, options.vlrCount ?? 1, true);
  if ((options.vlrCount ?? 1) > 0) {
    bytes.set(
      new TextEncoder().encode(options.userId ?? "copc"),
      headerSize + 2,
    );
    view.setUint16(headerSize + 18, options.recordId ?? 1, true);
  }
  return bytes;
}
