import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries, not one: `decode-worker.ts` has to land in `dist` as its own
  // file so `new URL("./decode-worker.js", import.meta.url)` in `decode-pool`
  // resolves next to `index.js`. Bundling it into the index would leave the
  // pool pointing at a file that does not exist.
  entry: ["src/index.ts", "src/decode-worker.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
});
