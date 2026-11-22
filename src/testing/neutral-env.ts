import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BLINDING_WORDS, textHits } from "../blinding.js";

// Gives every test worker an environment that holds no blinding word and no mention of this tool, whatever the
// operator's is: a fresh TMPDIR. A command that starts a real run checks it before it starts. vitest.config.ts lists this file as a setup file.
// The system's temp directory is used unless the operator's holds a blinding word.
const base =
  textHits(os.tmpdir(), DEFAULT_BLINDING_WORDS).length === 0
    ? os.tmpdir()
    : "/tmp";
const tmp = fs.mkdtempSync(path.join(base, "runs-"));
process.env["TMPDIR"] = tmp;
process.on("exit", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
