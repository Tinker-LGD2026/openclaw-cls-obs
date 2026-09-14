// Assembles the distributable bundle directory and the tarball.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist-bundle");
const bundleFile = path.join(out, "index.mjs");
if (!fs.existsSync(bundleFile)) {
  throw new Error("dist-bundle/index.mjs missing; run `npm run bundle` first");
}
if (!fs.existsSync(`${bundleFile}.map`)) {
  throw new Error("dist-bundle/index.mjs.map missing; the bundle build must emit sourcemaps");
}

fs.copyFileSync(path.join(root, "openclaw.plugin.json"), path.join(out, "openclaw.plugin.json"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
// npm renders the package page from the bundled README.
fs.copyFileSync(path.join(root, "README.md"), path.join(out, "README.md"));

// npm Trusted Publishing verifies `repository` against the OIDC token's repo
// claim (a mismatch fails with 422). The checkout's origin is the one source
// that always matches, so derive it from git; local packs without a remote
// just omit it (provenance is only requested in CI).
function resolveRepository() {
  try {
    const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const match = /github\.com[:/](?<path>[^/]+\/[^/]+?)(?:\.git)?$/.exec(origin);
    if (!match?.groups?.path) {
      return undefined;
    }
    return { type: "git", url: `git+https://github.com/${match.groups.path}.git` };
  } catch {
    return undefined;
  }
}
const repository = resolveRepository();
if (!repository) {
  console.warn("pack-dist: no git origin; package.json will lack `repository` (CI provenance needs it)");
}

fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "openclaw-cls-agent-observability",
      version: pkg.version,
      type: "module",
      ...(repository ? { repository } : {}),
      openclaw: {
        extensions: ["./index.mjs"],
        compat: pkg.openclaw?.compat,
      },
    },
    null,
    2,
  ) + "\n",
);

// Tarball + checksums at repo-root dist/ for CI upload.
const repoDist = path.join(root, "dist");
fs.mkdirSync(repoDist, { recursive: true });
const tarball = path.join(repoDist, `cls-agent-observability-${pkg.version}.tar.gz`);
// COPYFILE_DISABLE keeps macOS bsdtar from injecting ._ AppleDouble entries.
execFileSync("tar", ["-czf", tarball, "-C", out, "."], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
const sha = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
// The checksum entry names the distributed object (plugin.tar.gz), not the
// versioned local file — install.sh verifies the downloaded plugin.tar.gz.
fs.writeFileSync(path.join(repoDist, "SHA256SUMS"), `${sha}  plugin.tar.gz\n`);
console.log(`packed ${tarball}`);
