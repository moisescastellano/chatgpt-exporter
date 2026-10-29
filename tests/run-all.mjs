import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const testsDir = dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

if (!testFiles.length) {
  console.error("No tests/*.test.mjs files found.");
  process.exit(1);
}

let failed = 0;

for (const testFile of testFiles) {
  console.log(`\n=== ${basename(testFile)} ===`);
  const result = spawnSync(process.execPath, [join(testsDir, testFile)], {
    cwd: join(testsDir, ".."),
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    failed += 1;
  } else if (result.status !== 0) {
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${testFiles.length} test file(s) passed.`);
