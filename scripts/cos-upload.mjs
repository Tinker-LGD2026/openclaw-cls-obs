// Uploads release artifacts to COS with the official Node SDK.
//
// Usage:
//   COS_SECRET_ID=… COS_SECRET_KEY=… COS_BUCKET=name-123 COS_REGION=ap-shanghai \
//   node probe/cos-upload.mjs <version> <file>...
//
// Objects land at cos://<bucket>/cls-agent-observability/<version>/<name> and a
// copy under latest/.
import fs from "node:fs";
import path from "node:path";

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env;
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error("needs COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET (name-appid), COS_REGION");
  process.exit(2);
}
const [version, ...files] = process.argv.slice(2);
if (!version || files.length === 0) {
  console.error("usage: node probe/cos-upload.mjs <version> <file>...");
  process.exit(2);
}

const { default: COS } = await import("cos-nodejs-sdk-v5");
const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

async function put(file, key) {
  await cos.putObject({
    Bucket: COS_BUCKET,
    Region: COS_REGION,
    Key: key,
    Body: fs.createReadStream(file),
  });
  console.log(`uploaded ${path.basename(file)} -> ${key}`);
}

/** Distributed object names are stable; only the local tarball is versioned. */
function objectName(localFile) {
  const base = path.basename(localFile);
  if (/^cls-agent-observability-.*\.tar\.gz$/.test(base)) {
    return "plugin.tar.gz";
  }
  return base;
}

for (const file of files) {
  const name = objectName(file);
  await put(file, `cls-agent-observability/${version}/${name}`);
  await put(file, `cls-agent-observability/latest/${name}`);
}
