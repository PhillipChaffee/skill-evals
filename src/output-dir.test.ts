import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { outputDir } from "./output-dir.js";
import { UsageError } from "./scope.js";

test("a default output directory under a state directory that cannot be written is a usage error naming --out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  try {
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "");
    const env = { SKILL_EVALS_STATE_DIR: path.join(file, "state") };
    expect(() => outputDir(undefined, root, env)).toThrow(UsageError);
    expect(() => outputDir(undefined, root, env)).toThrow(
      /cannot create the default output directory .*--out <dir>.*SKILL_EVALS_STATE_DIR/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
