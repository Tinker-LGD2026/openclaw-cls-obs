import { defineConfig } from "tsup";

// Single-file zero-dependency bundle for distribution: every @opentelemetry
// package is inlined so customer installs never run npm for this plugin.
export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist-bundle",
  outExtension: () => ({ js: ".mjs" }),
  noExternal: [/^@opentelemetry\//],
  // One artifact, no chunks: code splitting is off, and the build cleans the
  // outdir so stale chunks from older builds never ship.
  splitting: false,
  clean: true,
  sourcemap: true,
  minify: false,
  banner: { js: "// cls-agent-observability bundled build" },
});
