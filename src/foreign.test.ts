import { expect, test } from "vitest";
import claudeCode from "./harnesses/claude-code.js";
import type { Loaded, LoadedSubject } from "./harnesses/shared.js";
import { NOT_REPORTED, foreignOf } from "./harnesses/shared.js";

const KIT_COPY = "/run/kit-1";

const copy = (kind: LoadedSubject["kind"]): LoadedSubject => ({
  kind,
  dir: KIT_COPY,
  skills: ["greet"],
  skillDirs: {},
});

test("the default foreign list names every reported plugin path, skill, agent, server and hook the subject does not own", () => {
  const loaded: Loaded = {
    paths: [KIT_COPY, "/other"],
    skills: ["greet", "stray"],
    agents: ["a"],
    rules: ["r"],
    hooks: ["h"],
    mcpServers: ["m"],
  };
  const plain = {};
  expect(foreignOf(plain, loaded, copy("plugin"))).toEqual([
    "/other",
    "skill stray",
    "agent a",
    "MCP server m",
    "hook h",
  ]);
  expect(foreignOf(plain, loaded, null)).toContain(KIT_COPY);
  expect(foreignOf(plain, loaded, copy("skills"))).toContain(KIT_COPY);
  expect(foreignOf(plain, NOT_REPORTED, null)).toEqual([]);
});

test("claude-code treats a prefixed skill of another plugin as foreign and a bare name as a built-in", () => {
  const loaded: Loaded = {
    ...NOT_REPORTED,
    paths: [KIT_COPY, "/org"],
    skills: ["greet", "x", "init"],
    rawSkills: ["kit:greet", "org:x", "init"],
    plugins: [
      { name: "kit", path: KIT_COPY },
      { name: "org", path: "/org" },
    ],
  };
  expect(foreignOf(claudeCode, loaded, copy("plugin"))).toEqual([
    "/org",
    "skill org:x",
  ]);
});

test("claude-code reads agents and MCP servers: only the subject plugin's are its own", () => {
  const loaded: Loaded = {
    ...NOT_REPORTED,
    paths: [KIT_COPY],
    plugins: [{ name: "kit", path: KIT_COPY }],
    agents: ["Explore", "kit:a", "org:b"],
    mcpServers: ["plugin:kit:db", "plugin:org:db", "managed"],
  };
  expect(foreignOf(claudeCode, loaded, copy("plugin"))).toEqual([
    "agent org:b",
    "MCP server plugin:org:db",
    "MCP server managed",
  ]);
  expect(foreignOf(claudeCode, loaded, null)).toContain(
    "MCP server plugin:kit:db",
  );
});

test("claude-code finds a plugin an account synced into the config directory by its path", () => {
  const synced = "/run/home-1/.claude/plugins/synced/design";
  const loaded: Loaded = {
    ...NOT_REPORTED,
    paths: [KIT_COPY, synced],
    plugins: [
      { name: "kit", path: KIT_COPY },
      { name: "design", path: synced },
    ],
  };
  expect(foreignOf(claudeCode, loaded, copy("plugin"))).toEqual([synced]);
});
