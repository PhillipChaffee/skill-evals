import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { HARNESSES } from "./harnesses/index.js";
import { startMcp, stageMcp, withMockLog } from "./mcp/stage.js";
import type { McpSource } from "./mcp/types.js";
import { scoreSubject } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import { parseText } from "./testing/streams.js";
import {
  GET_ISSUE,
  HIDDEN_ISSUE,
  TOOL,
  inside,
  plantLookup,
} from "./testing/mcp.js";

const NONE = "none";
const SERVER = "tracker";
const PI = "pi";
const TOOL_FILE = "cases/c/mcp/tracker/get.json";

test("a call that only the mock log shows makes the run invalid, and the stream is not changed", async () => {
  const box = sandbox();
  const cases = plantLookup(box, [HIDDEN_ISSUE]);
  const ran = await scoreSubject(box, { subject: NONE, cases });
  expect(ran.status).toBe(EXIT.invalid);
  const [record] = ran.records;
  expect(record?.score).toBeNull();
  expect(record?.mcpProblems).toEqual([
    "the mock log and the stream disagree: tracker.get_issue: the stream shows 0, the log 1",
  ]);
  // The stream's own calls are what a check sees: the logged call was not merged in.
  expect(record?.toolCalls).toEqual([]);
});

test("under --isolated the registered mock servers are not unexpected, and any other MCP server still is", async () => {
  const box = sandbox();
  const flags = ["--isolated"];
  const clean = await scoreSubject(box, {
    ...{ subject: NONE, cases: plantLookup(box), flags },
  });
  expect(clean.status, clean.stderr).toBe(0);
  expect(clean.records[0]?.loaded.mcpServers).toEqual([SERVER]);
  expect(clean.records[0]?.unexpected).toEqual([]);

  const other = sandbox();
  const init = { mcp_servers: [{ name: SERVER }, { name: "somebody-elses" }] };
  const cases = plantLookup(other, [GET_ISSUE], { init });
  const breach = await scoreSubject(other, { subject: NONE, cases, flags });
  expect(breach.status).toBe(EXIT.invalid);
  expect(breach.records[0]?.unexpected).toEqual(["MCP server somebody-elses"]);
  expect(breach.records[0]?.score).toBeNull();
});

/**
 * Plants one case with one server.
 * @returns The sandbox, the servers, and the run's home and workspace.
 */
function planted() {
  const box = sandbox();
  box.write(TOOL_FILE, TOOL);
  const source: McpSource = {
    dir: path.join(box.root, "cases/c/mcp"),
    servers: [SERVER],
  };
  return { box, source, dirs: { home: box.root, workspace: box.root } };
}

test("the staged servers are a copy, and removing them leaves the case alone", () => {
  const { box, source } = planted();
  const staged = stageMcp(source);
  const [server] = staged.servers;
  // The command names a neutral copy of the script, not this package.
  expect(path.basename(server?.args[0] ?? "")).toMatch(/^server\.m(ts|js)$/);
  expect(server?.args[0]).not.toContain("skill-evals");
  expect(path.basename(staged.dir)).toMatch(/^svc-/);
  expect(path.basename(staged.log)).toBe("calls.log");
  expect(Object.keys(server?.env ?? {})).toEqual(["CALLS_LOG"]);
  // The script the agent can read says nothing of what it is for or whose it is.
  const script = fs.readFileSync(server?.args[0] ?? "", "utf8");
  expect(script).not.toMatch(/mock|skill-evals|^#!/im);
  expect(script).not.toContain("//");
  expect(server?.args.at(-2)).toBe(SERVER);
  expect(server?.args.at(-1)).toBe(path.join(staged.dir, "servers/tracker"));
  expect(server?.env).toEqual({ CALLS_LOG: staged.log });
  expect(fs.existsSync(path.join(staged.dir, "servers/tracker/get.json"))).toBe(
    true,
  );
  expect(inside(box.root, staged.dir)).toBe(false);
  staged.dispose();
  expect(fs.existsSync(staged.dir)).toBe(false);
  expect(fs.existsSync(path.join(source.dir, "tracker/get.json"))).toBe(true);
});

test("a harness that cannot register MCP servers makes the run unable to start, and a registration that throws says why", () => {
  const { source, dirs } = planted();
  const without = startMcp({ id: PI }, source, dirs);
  expect(without.failure).toBe("pi cannot register MCP servers");
  without.staged.dispose();
  const failing = {
    id: PI,
    registerMcp: () => {
      throw new Error("disk full");
    },
  };
  const throwing = startMcp(failing, source, dirs);
  expect(throwing.failure).toBe(
    "could not register the MCP servers for pi: disk full",
  );
  throwing.staged.dispose();
  const claude = HARNESSES.find((harness) => harness.id === "claude-code");
  if (!claude) throw new Error("no claude-code");
  const registered = startMcp(claude, source, dirs);
  expect(registered.failure).toBeNull();
  const config = path.join(registered.staged.dir, "servers.json");
  expect(fs.readFileSync(config, "utf8")).toContain('"type": "stdio"');
  registered.staged.dispose();
});

test("a harness without mcp reads the log and changes nothing, one that shows MCP calls in its stream cross-checks it, and one that cannot merges it", () => {
  const { source, dirs } = planted();
  const started = startMcp(
    { id: PI, registerMcp: () => undefined },
    source,
    dirs,
  );
  const log = JSON.stringify({
    server: SERVER,
    tool: "get",
    input: {},
    response: { text: "t", isError: false },
    at: "2026-01-01T00:00:00Z",
  });
  fs.writeFileSync(started.staged.log, `${log}\n`);
  const parsed = parseText("claude-code", "");
  const none = { capabilities: new Set<never>() };
  const without = withMockLog(none, parsed, started);
  expect(without.parsed).toBe(parsed);
  expect(without).toMatchObject({ mcpLog: `${log}\n`, mcpProblems: [] });
  // The stream shows MCP calls: the log is a cross-check, and its extra line is a problem.
  const stream = { capabilities: new Set(["mcp" as const]) };
  const checked = withMockLog(stream, parsed, started);
  expect(checked.parsed).toBe(parsed);
  expect(checked.mcpProblems).toEqual([
    "the mock log and the stream disagree: tracker.get: the stream shows 0, the log 1",
  ]);
  // The stream cannot show them: the log is merged, and nothing disagrees.
  const hidden = { ...stream, mcpCalls: "log" as const };
  const merged = withMockLog(hidden, parsed, started);
  expect(merged.parsed.toolCalls.map((call) => call.source)).toEqual([
    "mock-log",
  ]);
  expect(merged.mcpProblems).toEqual([]);
  expect(withMockLog(none, parsed, null)).toEqual({
    parsed,
    mcpLog: null,
    mcpProblems: [],
  });
  started.staged.dispose();
  expect(inside(started.staged.dir, started.staged.dir)).toBe(true);
});
