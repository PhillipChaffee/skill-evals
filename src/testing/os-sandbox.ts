import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "./sandbox.js";

const EXECUTABLE = 0o755;

/** A stand-in for `bwrap` that a test put on the sandbox's PATH. */
export interface FakeBwrap {
  /** The arguments of each start, in order. */
  starts: () => string[][];
}

/**
 * Puts a `bwrap` on the sandbox's PATH that confines nothing: it logs its arguments and runs the command after `--`.
 * It lets a test see how a run is wrapped, with no real sandbox and no user namespaces.
 * @param box - The sandbox, whose PATH directory is the one that holds `started.log`.
 * @returns How to read what it logged.
 */
export function fakeBwrap(box: Sandbox): FakeBwrap {
  const tools = path.dirname(box.started);
  const log = path.join(tools, "bwrap.log");
  fs.writeFileSync(
    path.join(tools, "bwrap"),
    `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const at = args.indexOf("--");
const ran = spawnSync(args[at + 1], args.slice(at + 2), { stdio: "inherit" });
process.exit(ran.status ?? 1);
`,
    { mode: EXECUTABLE },
  );
  return {
    starts: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}
