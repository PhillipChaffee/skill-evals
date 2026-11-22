import fs from "node:fs";
import path from "node:path";
import { script, skillsFolder } from "./plant.js";
import type { FakeScript } from "./plant.js";
import { readResults } from "./sandbox.js";
import type { Sandbox } from "./sandbox.js";

const DONE = { type: "output_contains", text: "done" };
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

/** A case to plant: its case file, its other files below its directory, and what the agent does. */
interface Planted {
  id?: string;
  case: Record<string, unknown>;
  files?: Record<string, string>;
  agent?: FakeScript["turns"][number];
  env?: Record<string, string>;
}

/**
 * Plants one case and scores it with the scripted agent, with the system's tools on the setup's `PATH`.
 * @param box - The sandbox.
 * @param planted - The case.
 * @returns The command's status and stderr, the results, and the output directory.
 */
export async function go(box: Sandbox, planted: Planted) {
  const id = planted.id ?? "restate";
  box.write(`cases/${id}/prompt.md`, "say it in plain words\n");
  box.write(`cases/${id}/case.json`, { checks: [DONE], ...planted.case });
  for (const [name, content] of Object.entries(planted.files ?? {})) {
    box.write(`cases/${id}/${name}`, content);
  }
  script(box, "agent", {
    turns: [[...(planted.agent ?? []), { final: "done" }]],
  });
  const out = path.join(box.root, "results");
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  const ran = await box.cli(
    [
      ...[
        "score",
        "--subject",
        subject,
        "--cases",
        path.join(box.root, "cases"),
      ],
    ].concat(["--reps", "1", "--out", out]),
    { PATH: `${String(box.env["PATH"])}:${SYSTEM_PATH}`, ...planted.env },
  );
  const results = fs.existsSync(path.join(out, "results.json"))
    ? readResults(out)
    : null;
  return { status: ran.status, stderr: ran.stderr, results, out };
}

/**
 * Reads what the scripted agent's shell commands printed.
 * @param out - The output directory.
 * @param id - The case's id.
 * @returns The output of each tool call, in order.
 */
export function printed(out: string, id = "restate"): string[] {
  const stream = fs.readFileSync(
    path.join(out, `claude-code/${id}/subject1.stream.jsonl`),
    "utf8",
  );
  return stream
    .split("\n")
    .filter((line) => line.includes("tool_result"))
    .flatMap((line) => {
      const event = JSON.parse(line) as {
        message?: { content?: { type: string; content: unknown }[] };
      };
      return (event.message?.content ?? [])
        .filter((part) => part.type === "tool_result")
        .map((part) => String(part.content));
    });
}
