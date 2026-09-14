// Replays real captured OpenClaw traffic and prints the resulting CLS tree.
//
// Single-mode entry point. Content mode comes from CLS_CONTENT_MODE (default
// `truncate`); use `npm test` to exercise both modes.
import type { ContentMode } from "../config.js";
import { resolveCaptureDir, runSuite } from "./suite.js";

function main(): void {
  const contentMode = (process.env.CLS_CONTENT_MODE ?? "truncate") as ContentMode;
  console.log(`capture dir: ${resolveCaptureDir()}`);
  console.log(`内容采集模式: ${contentMode}`);

  const result = runSuite({ contentMode, verbose: true });
  console.log(
    `\n捕获文件=${result.captureCount}  span=${result.spanCount}  协议问题=${result.issueCount}`,
  );
  if (result.issueCount > 0) {
    process.exitCode = 1;
  }
}

main();
