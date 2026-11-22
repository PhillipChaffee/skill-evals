// Runs every spec file of this folder and says how many failed.
const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
for (const file of fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".spec.js"))) {
  for (const [name, holds] of require(path.join(__dirname, file))) {
    if (!holds()) {
      console.log(`FAIL ${name}`);
      failed += 1;
    }
  }
}
console.log(failed === 0 ? "all passed" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
