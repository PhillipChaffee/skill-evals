import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { script } from "./testing/plant.js";
import { scoreSubject } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import {
  GET_ISSUE,
  configOf,
  inside,
  plantLookup,
  seenBy,
} from "./testing/mcp.js";

const NONE = "none";
const SERVER = "tracker";
const LOG_SUFFIX = ".mock-log.jsonl";

test("the mock directory is never inside the workspace", async () => {
  const box = sandbox();
  const ran = await scoreSubject(box, {
    subject: NONE,
    cases: plantLookup(box),
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.records[0]?.score).toBe(1);
  const seen = seenBy(box);
  const server = configOf(seen).mcpServers[SERVER];
  expect(server).toBeDefined();
  // The config, the log and the server's own files all lie outside the workspace and the home.
  const named = [
    seen.configFile,
    server?.env["MOCK_LOG"] ?? "",
    server?.args.at(-1) ?? "",
  ];
  for (const file of named) {
    expect(file).not.toBe("");
    expect(inside(seen.cwd, file), file).toBe(false);
    expect(inside(seen.home, file), file).toBe(false);
  }
  const temp = fs.realpathSync(os.tmpdir());
  expect(path.dirname(seen.configFile).startsWith(temp)).toBe(true);
  // The workspace is as the case made it: no mock directory was copied into it.
  expect(seen.files).toEqual([]);
  // The run's directory is gone afterwards.
  expect(fs.existsSync(seen.configFile)).toBe(false);
});

test("the cases path never appears in what the agent can see", async () => {
  const box = sandbox();
  const cases = plantLookup(box);
  await scoreSubject(box, { subject: NONE, cases });
  const seen = seenBy(box);
  const visible = JSON.stringify([
    ...[seen.argv, seen.config, seen.cwd, seen.home, seen.files, seen.env],
  ]);
  expect(visible).not.toContain(cases);
  expect(visible).not.toContain("lookup");
  // The server reads a copy of its files, which sits in the run's own directory.
  const copy = configOf(seen).mcpServers[SERVER]?.args.at(-1) ?? "";
  expect(inside(cases, copy)).toBe(false);
});

test("MOCK_LOG reaches the servers only, never the agent's environment", async () => {
  const box = sandbox();
  const leaked = "/leak/by/environment";
  await scoreSubject(box, {
    subject: NONE,
    cases: plantLookup(box),
    env: { MOCK_LOG: leaked },
  });
  const seen = seenBy(box);
  expect(seen.env).not.toContain("MOCK_LOG");
  const env = configOf(seen).mcpServers[SERVER]?.env ?? {};
  expect(Object.keys(env)).toEqual(["MOCK_LOG"]);
  expect(env["MOCK_LOG"]).not.toBe(leaked);
});

test("the mock log is kept in the out directory, after the run's own copy is gone", async () => {
  const box = sandbox();
  const out = path.join(box.root, "results");
  const cases = plantLookup(box, [GET_ISSUE, GET_ISSUE]);
  const ran = await scoreSubject(box, { subject: NONE, cases, out });
  expect(ran.status, ran.stderr).toBe(0);
  const dir = path.join(out, "claude-code/lookup");
  const kept = fs.readdirSync(dir).filter((name) => name.endsWith(LOG_SUFFIX));
  expect(kept).toHaveLength(1);
  const [name = ""] = kept;
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8");
  const calls = read(name)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    server: SERVER,
    tool: "get_issue",
    input: { id: "SHOP-7" },
    response: { text: "SHOP-7: Cart empties on login.", isError: false },
  });
  expect(typeof calls[0]?.["at"]).toBe("string");
  // The agent saw the same text as the log holds.
  const transcript = JSON.parse(
    read(name.replace(LOG_SUFFIX, ".transcript.json")),
  ) as { type: string; output?: string }[];
  const result = transcript.find((event) => event.type === "tool_result");
  expect(result?.output).toBe("SHOP-7: Cart empties on login.");
});

test("a case without mcp keeps no mock log and starts no mock server", async () => {
  const box = sandbox();
  box.write("cases/plain/prompt.md", "say done\n");
  box.write("cases/plain/case.json", {
    checks: [{ type: "output_contains", text: "done" }],
  });
  const out = path.join(box.root, "results");
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const cases = path.join(box.root, "cases");
  await scoreSubject(box, { subject: NONE, cases, out });
  const kept = fs.readdirSync(path.join(out, "claude-code/plain"));
  expect(kept.some((name) => name.includes("mock-log"))).toBe(false);
  expect(fs.existsSync(path.join(box.root, "fake/mcp-seen.json"))).toBe(false);
});
