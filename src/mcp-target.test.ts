import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { BLINDING, CASES, play, scores } from "./testing/target.js";

const ID = "external-sources-through-mocks";
// The checks, in order: three subagents in one turn; each server called by its investigator; each investigator keeps to
// its own server; the main thread calls no MCP tool; no write-type MCP call; no write or edit; the answer holds both
// claims, cites both places and names the contradiction.
const ALL_PASS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

test("external sources: the prompt tells the agent nothing about being graded, and the case needs mcp", () => {
  const [found] = loadCases(CASES, ID);
  expect(found?.prompt).not.toMatch(BLINDING);
  expect(found?.mcp?.servers).toEqual(["chat", "tracker", "wiki"]);
});

test("external sources: three investigators in one turn, each on its own server, no write, and both sides of the contradiction cited, score 1", async () => {
  const record = await play(`${ID}.match`);
  expect(scores(record)).toEqual(ALL_PASS);
  expect(record.score).toBe(1);
  const mcp = record.toolCalls.filter((call) => call.kind === "mcp");
  expect(mcp.map((call) => call.name)).toEqual([
    "tracker.search_issues",
    "tracker.get_issue",
    "wiki.get_page",
    "chat.read_channel",
  ]);
  expect(record.unexpected).toEqual([]);
});

const VARIANTS = [
  // Wiki's investigator also reads the tracker: it breaks its own keep-to-one-server check.
  ["shared-server", [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1]],
  ["writes", [1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1]],
  ["sequential", [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
  ["main-reads", [1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]],
  // Two investigators: the count is two, and the wiki's investigator never ran, so its server was not called and it
  // cannot be shown to have kept to its own.
  ["two-sources", [0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1]],
  ["file-write", [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1]],
  ["silent-contradiction", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]],
  ["one-cited", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]],
] as const;

test.each(VARIANTS)(
  "external sources: %s fails exactly the checks it should",
  async (name, expected) => {
    const record = await play(`${ID}.${name}`);
    expect(scores(record)).toEqual(expected);
  },
);
