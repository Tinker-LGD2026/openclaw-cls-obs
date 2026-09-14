// Runs the full verification suite across both content modes.
//
// Content capture changes which attributes are emitted, so a single-mode run can
// miss both content leaks (when off) and malformed content (when on). This entry
// point exercises both and reports one combined result.

import { runSuite } from "./suite.js";

function main(): void {
  const modes = ["truncate", "off"] as const;
  let failed = 0;

  for (const mode of modes) {
    console.log(`\n${"=".repeat(64)}`);
    console.log(`内容采集模式: ${mode}`);
    console.log("=".repeat(64));
    const result = runSuite({ contentMode: mode, verbose: mode === "truncate" });
    console.log(
      `\n[${mode}] 捕获文件=${result.captureCount}  span=${result.spanCount}  协议问题=${result.issueCount}`,
    );
    if (result.issueCount > 0) {
      failed += 1;
    }
  }

  console.log(`\n${"=".repeat(64)}`);
  if (failed > 0) {
    console.log(`失败：${failed}/${modes.length} 个模式存在协议问题`);
    process.exitCode = 1;
    return;
  }
  console.log(`通过：${modes.length}/${modes.length} 个模式，协议问题=0`);
}

main();
