import fs from "node:fs";
import path from "node:path";

// Gives every test worker an environment that holds no blinding word and no mention of this tool, whatever the
// operator's is: a fresh TMPDIR, and a PATH without the directories that name this tool (`npm run` puts the project's
// node_modules/.bin there, and the project may be called skill-evals). A command that starts a real run checks both
// before it starts. vitest.config.ts lists this file as a setup file.
const tmp = fs.mkdtempSync(path.join("/tmp", "runs-"));
process.env["TMPDIR"] = tmp;
process.env["PATH"] = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .filter((entry) => !/skill.?evals?/i.test(entry))
  .join(path.delimiter);
process.on("exit", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
