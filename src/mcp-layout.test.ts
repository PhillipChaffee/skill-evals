import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { loadMcp } from "./mcp/mocks.js";
import { sandbox } from "./testing/sandbox.js";
import { TOOL } from "./testing/mcp.js";

const TOOL_FILE = "s/t.json";
const ONLY_TOOL_FILES = /only regular files named <tool>\.json/;

/**
 * Plants a case with the given files under `mcp/`.
 * @param files - Path below `mcp/` to content; a string is written as it is, any other value as JSON.
 * @returns The sandbox, and a `load` that loads the cases.
 */
function planted(files: Record<string, unknown>) {
  const box = sandbox();
  box.write("cases/c/prompt.md", "go\n");
  box.write("cases/c/case.json", {
    checks: [{ type: "output_contains", text: "x" }],
  });
  for (const [name, content] of Object.entries(files)) {
    box.write(`cases/c/mcp/${name}`, content);
  }
  return { box, load: () => loadCases(path.join(box.root, "cases")) };
}

/**
 * Makes a tool file with a response list.
 * @param responses - What the file's `responses` holds.
 * @returns A tool file that is otherwise valid.
 */
const withResponses = (responses: unknown[]) => ({ ...TOOL, responses });

test("a case with an mcp directory loads its servers, and one without has none", () => {
  const { load, box } = planted({
    "tracker/get.json": TOOL,
    "wiki/page-1.json": TOOL,
  });
  expect(load()[0]?.mcp?.servers).toEqual(["tracker", "wiki"]);
  const plain = planted({});
  expect(plain.load()[0]?.mcp).toBeUndefined();
  expect(loadMcp(path.join(box.root, "cases/none"), "case.json")).toBeNull();
});

test.each([
  [
    "an unknown key of a tool file",
    { [TOOL_FILE]: { ...TOOL, extra: 1 } },
    /unknown key "extra"/,
  ],
  [
    "an unknown key of a response",
    { [TOOL_FILE]: withResponses([{ text: "t", more: 1 }]) },
    /unknown key "more"/,
  ],
  ["a tool file that is not JSON", { [TOOL_FILE]: "{" }, /s\/t\.json/],
  [
    "a tool file that is not an object",
    { [TOOL_FILE]: "[]" },
    /must be an object/,
  ],
  [
    "a description that is no string",
    { [TOOL_FILE]: { ...TOOL, description: 1 } },
    /"description" must be a string/,
  ],
  [
    "an inputSchema that is no object",
    { [TOOL_FILE]: { ...TOOL, inputSchema: [] } },
    /"inputSchema" must be an object/,
  ],
  [
    "no responses",
    { [TOOL_FILE]: withResponses([]) },
    /"responses" must be a non-empty list/,
  ],
  [
    "a response that is no object",
    { [TOOL_FILE]: withResponses([1]) },
    /a response must be an object/,
  ],
  [
    "a response without text",
    { [TOOL_FILE]: withResponses([{}]) },
    /"text" must be a string/,
  ],
  [
    "an isError that is no boolean",
    { [TOOL_FILE]: withResponses([{ text: "t", isError: 1 }]) },
    /"isError" must be true or false/,
  ],
  [
    "a when that is no object",
    { [TOOL_FILE]: withResponses([{ text: "t", when: [] }]) },
    /"when" must be an object/,
  ],
  [
    "a when pattern that is no string",
    { [TOOL_FILE]: withResponses([{ text: "t", when: { a: 1 } }]) },
    /when\.a must be a regular expression/,
  ],
  [
    "a when pattern that does not compile",
    { [TOOL_FILE]: withResponses([{ text: "t", when: { a: "(" } }]) },
    /when\.a is not a regular expression/,
  ],
  [
    "a server name with a capital",
    { "Tracker/t.json": TOOL },
    /mcp\/Tracker must be a directory named like/,
  ],
  [
    "a server name with a double underscore",
    { "a__b/t.json": TOOL },
    /without "__"/,
  ],
  [
    "a file where a server directory belongs",
    { tracker: "x" },
    /mcp\/tracker must be a directory/,
  ],
  [
    "a tool name that starts with a digit",
    { "s/1t.json": TOOL },
    ONLY_TOOL_FILES,
  ],
  ["a file that is no .json", { "s/t.txt": "x" }, ONLY_TOOL_FILES],
])("mcp layout: %s is a load error", (_name, files, message) => {
  expect(planted(files).load).toThrow(message);
});

test("mcp layout: an empty mcp directory, an empty server, a link, and a file are load errors", () => {
  const empty = planted({});
  fs.mkdirSync(path.join(empty.box.root, "cases/c/mcp"));
  expect(empty.load).toThrow(/mcp\/ holds no server/);

  const bare = planted({});
  fs.mkdirSync(path.join(bare.box.root, "cases/c/mcp/s"), { recursive: true });
  expect(bare.load).toThrow(/s: holds no tool files/);

  const linked = planted({ [TOOL_FILE]: TOOL });
  const under = path.join(linked.box.root, "cases/c/mcp/s");
  fs.symlinkSync(path.join(under, "t.json"), path.join(under, "u.json"));
  expect(linked.load).toThrow(/links are not followed/);

  const file = planted({});
  fs.writeFileSync(path.join(file.box.root, "cases/c/mcp"), "x");
  expect(file.load).toThrow(/mcp must be a directory/);
});
