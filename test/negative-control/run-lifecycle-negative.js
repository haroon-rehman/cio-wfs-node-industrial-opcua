"use strict";

/**
 * MEM-006a negative control.
 *
 * Copies the *pre-fix* `opcua/102-opcuaclient.js` out of git (`HEAD`) into a
 * temporary directory and runs the lifecycle suite against that copy. The run
 * must FAIL: if it passes, the suite does not actually detect the dead close
 * branch and its positive result is meaningless.
 *
 * Usage: node test/negative-control/run-lifecycle-negative.js
 *        CIO_OPCUA_PREFIX_REF=<pre-fix commit> to pin the control to a commit
 *        other than HEAD (required once the fix itself is committed).
 * Exit codes: 0 = the suite failed on the pre-fix source (control proven),
 *             1 = the suite passed on the pre-fix source (control broken),
 *             2 = the control could not be set up.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..", "..");
const prefixRef = process.env.CIO_OPCUA_PREFIX_REF || "HEAD";
const gitShow = spawnSync("git", ["show", `${prefixRef}:opcua/102-opcuaclient.js`], {
  cwd: packageRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
});

if (gitShow.status !== 0) {
  console.error(`negative control: could not read the pre-fix source from git ${prefixRef}`);
  console.error(gitShow.stderr || gitShow.error);
  process.exit(2);
}

const sourceText = gitShow.stdout;
if (!sourceText.includes("node.disconnecting")) {
  console.error(`negative control: ${prefixRef} no longer contains the pre-fix \`node.disconnecting\` guard`);
  console.error("negative control: set CIO_OPCUA_PREFIX_REF to the pre-fix commit");
  process.exit(2);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cio-opcua-prefix-"));
const sourcePath = path.join(workDir, "102-opcuaclient.prefix.js");
fs.writeFileSync(sourcePath, sourceText, "utf8");

console.log(`negative control: pre-fix source from git ${prefixRef} -> ${sourcePath}`);

const run = spawnSync(
  process.execPath,
  ["--test", "--test-timeout=60000", "test/opcuaClientLifecycle.test.js"],
  {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, CIO_OPCUA_CLIENT_SOURCE: sourcePath }
  }
);

fs.rmSync(workDir, { recursive: true, force: true });

const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
process.stdout.write(output);

const failedMatch = output.match(/^# fail (\d+)$/m);
const failed = failedMatch ? Number(failedMatch[1]) : 0;

if (run.status !== 0 && failed > 0) {
  console.log(`negative control proven: ${failed} lifecycle test(s) fail on the pre-fix source`);
  process.exit(0);
}

console.error("negative control FAILED: the lifecycle suite passed against the pre-fix source");
process.exit(1);
