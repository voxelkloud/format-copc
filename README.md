# @voxelkloud/format-copc

The [COPC](https://copc.io) driver for [voxelkloud](../../README.md).

```sh
npm install @voxelkloud/format-copc
```

```ts
import { copcFormat } from "@voxelkloud/format-copc";
import { formats, loadPointCloud } from "@voxelkloud/loader";

formats.register(copcFormat);

const { source, tree, openPoints } = await loadPointCloud(
  "https://cdn.example/survey.copc.laz",
);
view.addCloud(source, tree, openPoints);
```

NOT registered by default. That is a bundle decision, not a judgement: this
driver pulls in a wasm LAZ decoder, and an app that only reads Potree should not
carry 148 KB of it to find that out.

## What it is

One file, one HTTP host, no conversion step. A COPC file is a LAS 1.4 file whose
point records are laszip chunks arranged as an octree, with the hierarchy in an
EVLR at the end. Everything this driver does is a byte range into that one URL:

- **one ranged read of the first 8 KiB** identifies the file and describes it
  completely — the LAS header, the `copc` info VLR, the `laszip` VLR and the
  Extra Bytes descriptor all live there by spec. A 2.7 MB file costs 8 KiB to
  open.
- **one read per hierarchy page.** An entry with a point count of -1 is a
  reference to another page; the tree fetches them as the camera descends.
- **one read per node.** A COPC node IS a bare laszip chunk — no chunk table in
  front of it, no header, and the point count comes from the hierarchy rather
  than the bytes. That is exactly the shape
  [`LazChunkDecoder`](../wasm-codecs/README.md) takes.

The host must honour `Range`. A server that answers 200 with the whole file is
accepted and sliced, because a small COPC file works that way and refusing it
would be pedantry; a 200 that does not even cover the requested range is not
recoverable and says so.

## What it is not

The octree is [`@voxelkloud/core`](../core/)'s `createPagedOctree` — Potree v2,
COPC and EPT all deliver a hierarchy in pages with references to further pages,
and that engine is shared. The LAS record is
[`@voxelkloud/format-las`](../format-las/)'s. The laszip decode is
[`@voxelkloud/wasm-codecs`](../wasm-codecs/)'s. What is here is what is
genuinely COPC: the 160-byte info VLR, the 32-byte hierarchy entry, and the -1
that means "continued elsewhere".

## Attribute names

`"position"`, `"rgb"`, `"intensity"`, `"classification"`, `"gps-time"`,
`"return number"` — PotreeConverter's names for the same LAS fields, on purpose.
A colour mode that keys off `"classification"` has to work on a COPC cloud and a
Potree cloud without the renderer knowing which it got. The bit-packed LAS
fields come apart into separate attributes, as they do in a Potree manifest, and
Extra Bytes dimensions keep their declared names.

`gps-time`'s domain comes from the info VLR, which is the only thing in a LAS
file that declares it — without it the float32 lane normalises against a range
of zero and every point decodes to 0.

## Testing

Against `demo/potree/pointclouds/lion_takanawa.copc.laz`, which came out of
`untwine`. A hand-built COPC fixture would be this driver's own idea of the
format checked against itself; the real file is the only oracle worth having.
It is gitignored, and the suite skips itself when it is absent.

The check that matters: every node's own point count, summed across the whole
hierarchy, equals the header's. A hierarchy read one entry short does not add up.

MIT.
