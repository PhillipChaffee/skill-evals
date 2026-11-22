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

test("a stream without MCP calls gets them from the mock log, marked mock-log, with an agent that is unknown", async () => {
  const box = sandbox();
  const checks = [
    { type: "tool_called", kind: "mcp", name: "^tracker\\.get_issue$", min: 1 },
    { type: "tool_called", kind: "mcp", min: 1, by: "main" },
    { type: "tool_called", kind: "mcp", min: 1, by: { agent: "unknown" } },
    {
      type: "tool_output_matches",
      tool: { kind: "mcp" },
      pattern: "Cart empties",
    },
  ];
  const cases = plantLookup(box, [HIDDEN_ISSUE], { checks });
  const ran = await scoreSubject(box, { subject: NONE, cases });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = ran.records;
  const calls = record?.toolCalls ?? [];
  expect(calls.map((c) => [c.kind, c.name, c.source, c.agent?.type])).toEqual([
    ["mcp", "tracker.get_issue", "mock-log", "unknown"],
  ]);
  // The log cannot say who made the call: the main thread did not, as far as a check can know.
  expect(record?.checks.map((check) => check.score)).toEqual([1, 0, 1, 1]);
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
  expect(server?.args.at(-2)).toBe(SERVER);
  expect(server?.args.at(-1)).toBe(path.join(staged.dir, "servers/tracker"));
  expect(server?.env).toEqual({ MOCK_LOG: staged.log });
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
  const config = path.join(registered.staged.dir, "mcp-config.json");
  expect(fs.readFileSync(config, "utf8")).toContain('"type": "stdio"');
  registered.staged.dispose();
});

test("a harness without mcp has no mock log merged into its run, and the staged log is read as it is", () => {
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
  const without = withMockLog({ capabilities: new Set() }, parsed, started);
  expect(without.parsed).toBe(parsed);
  expect(without.mcpLog).toBe(`${log}\n`);
  const claude = withMockLog(
    { capabilities: new Set(["mcp"]) },
    parsed,
    started,
  );
  expect(claude.parsed.toolCalls.map((call) => call.source)).toEqual([
    "mock-log",
  ]);
  expect(withMockLog({ capabilities: new Set() }, parsed, null)).toEqual({
    parsed,
    mcpLog: null,
  });
  started.staged.dispose();
  expect(inside(started.staged.dir, started.staged.dir)).toBe(true);
});
