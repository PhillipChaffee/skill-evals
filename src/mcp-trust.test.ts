import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { HARNESSES } from "./harnesses/index.js";
import { plugin } from "./testing/plant.js";
import { scoreSubject } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import {
  FORGED_ISSUE,
  GET_ISSUE,
  TAMPERED_SERVER,
  plantLookup,
} from "./testing/mcp.js";

const NONE = "none";
const MCP_FLAG = "--mcp-config";
const SERVER = "tracker";
const UP = "connected";
const CONNECTED = { name: SERVER, status: UP };

test("a line that an agent writes into the mock log makes the run invalid, whatever the checks say", async () => {
  const box = sandbox();
  const cases = plantLookup(box, [FORGED_ISSUE]);
  const ran = await scoreSubject(box, { subject: NONE, cases });
  expect(ran.status).toBe(EXIT.invalid);
  const [record] = ran.records;
  expect(record?.score).toBeNull();
  expect(record?.mcpProblems?.[0]).toMatch(
    /^the mock log and the stream disagree: tracker\.get_issue/,
  );
  // A line that matches a real call is no forgery: one call and one line agree.
  const honest = sandbox();
  const same = await scoreSubject(honest, {
    subject: NONE,
    cases: plantLookup(honest, [GET_ISSUE]),
  });
  expect(same.records[0]?.mcpProblems).toBeUndefined();
  expect(same.records[0]?.score).toBe(1);
});

test("a registered mock server that failed, or that the harness did not report, makes the run invalid", async () => {
  const failed = sandbox();
  const init = { mcp_servers: [{ name: SERVER, status: "failed" }] };
  const ran = await scoreSubject(failed, {
    subject: NONE,
    cases: plantLookup(failed, [GET_ISSUE], { init }),
  });
  expect(ran.status).toBe(EXIT.invalid);
  expect(ran.records[0]?.mcpProblems).toEqual([
    "the mock server tracker is failed, not connected",
  ]);
  expect(ran.records[0]?.score).toBeNull();

  const missing = sandbox();
  const none = await scoreSubject(missing, {
    subject: NONE,
    cases: plantLookup(missing, [GET_ISSUE], { init: { mcp_servers: [] } }),
  });
  expect(none.records[0]?.mcpProblems).toEqual([
    "the mock server tracker is missing from what the harness reported",
  ]);

  const fine = sandbox();
  const ok = await scoreSubject(fine, {
    subject: NONE,
    cases: plantLookup(fine, [GET_ISSUE], {
      init: { mcp_servers: [CONNECTED] },
    }),
  });
  expect(ok.records[0]?.mcpProblems).toBeUndefined();
});

test("in an mcp case, an MCP server that is neither a mock nor the subject plugin's own makes the run invalid, without --isolated too", async () => {
  const box = sandbox();
  const init = {
    mcp_servers: [CONNECTED, { name: "claude_ai_Gmail", status: UP }],
  };
  const ran = await scoreSubject(box, {
    subject: NONE,
    cases: plantLookup(box, [GET_ISSUE], { init }),
  });
  expect(ran.status).toBe(EXIT.invalid);
  expect(ran.records[0]?.mcpProblems?.[0]).toBe(
    "the harness reported MCP server claude_ai_Gmail, which is neither a mock server nor the subject's",
  );
  expect(ran.records[0]?.isolated).toBe(false);

  // The subject plugin's own server is its own.
  const owned = sandbox();
  const dir = plugin(owned, "kit", {});
  const own = {
    mcp_servers: [CONNECTED, { name: "plugin:plugin:own", status: UP }],
  };
  const cases = plantLookup(owned, [GET_ISSUE], { init: own });
  const fine = await scoreSubject(owned, { subject: dir, cases });
  expect(fine.records[0]?.mcpProblems).toBeUndefined();
  expect(fine.status, fine.stderr).toBe(0);
});

test("claude-code names the mock config, turns the claude.ai connectors off, and is strict only under --isolated", () => {
  const claude = HARNESSES.find((harness) => harness.id === "claude-code");
  if (!claude) throw new Error("no claude-code");
  const base = {
    subject: null,
    home: "/h",
    workspace: "/w",
    prompt: "p",
    turn: { index: 0, message: "p", invoke: null, event: null },
    session: null,
  };
  const loose = claude.invocation({ ...base, mcpDir: "/run" });
  expect(loose.args).toContain(MCP_FLAG);
  expect(loose.args[loose.args.indexOf(MCP_FLAG) + 1]).toBe(
    path.join("/run", "servers.json"),
  );
  expect(loose.args).not.toContain("--strict-mcp-config");
  expect(loose.env["ENABLE_CLAUDEAI_MCP_SERVERS"]).toBe("false");
  const strict = claude.invocation({ ...base, mcpDir: "/run", isolated: true });
  expect(strict.args).toContain("--strict-mcp-config");
  const plain = claude.invocation(base);
  expect(plain.args).not.toContain(MCP_FLAG);
  expect(plain.env).not.toHaveProperty("ENABLE_CLAUDEAI_MCP_SERVERS");
});

test("an agent that edits the files the mock servers run from makes the run invalid", async () => {
  const box = sandbox();
  const cases = plantLookup(box, [TAMPERED_SERVER, GET_ISSUE]);
  const ran = await scoreSubject(box, { subject: NONE, cases });
  expect(ran.status).toBe(EXIT.invalid);
  const [record] = ran.records;
  expect(record?.score).toBeNull();
  expect(record?.mcpProblems).toEqual([
    "the mock servers' files were changed during the run",
  ]);
  // The same run without the edit is valid.
  const honest = sandbox();
  const same = await scoreSubject(honest, {
    subject: NONE,
    cases: plantLookup(honest, [GET_ISSUE]),
  });
  expect(same.records[0]?.mcpProblems).toBeUndefined();
});
