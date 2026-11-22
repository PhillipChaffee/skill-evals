import path from "node:path";
import { expect, test } from "vitest";
import type { Case } from "./cases.js";
import { loadCases } from "./cases.js";
import { applicability, hostCapabilities } from "./applicability.js";
import { CAPABILITIES, readNeeds } from "./capabilities.js";
import { CHECKS } from "./checks/index.js";
import { HARNESSES } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";
import { sandbox } from "./testing/sandbox.js";

const MCP = "mcp";

const harness = (capabilities: Harness["capabilities"]): Harness => ({
  ...(HARNESSES[0] as Harness),
  id: "h",
  capabilities,
});
const caseOf = (more: Partial<Case>): Case => ({
  id: "c",
  base: "c",
  variant: null,
  heldout: false,
  prompt: "p",
  turns: null,
  checks: [{ type: "output_contains", text: "a", weight: 1 }],
  weight: 1,
  timeoutSeconds: 1,
  workspaceDir: null,
  graderDir: null,
  setup: [],
  fixtureDirs: [],
  fixtureDir: null,
  homeDir: null,
  extensions: {},
  tags: [],
  targets: [],
  guard: false,
  env: {},
  requires: [],
  ...more,
});

test("applicability combines the case, the checks and their types, and the host", () => {
  const host = new Set(["bin:git"]);
  const have = harness(new Set(["subagents"]));
  expect(applicability(have, caseOf({}), host)).toEqual({
    applicable: true,
    skipped: [],
  });
  expect(
    applicability(
      have,
      caseOf({ requires: ["subagents", MCP, "bin:x"] }),
      host,
    ),
  ).toEqual({
    applicable: false,
    missing: [MCP, "bin:x"],
    reason: "needs mcp, bin:x",
  });
  const spec = CHECKS["output_contains"];
  const before = spec?.needs;
  if (spec) spec.needs = () => ["childText"];
  try {
    expect(applicability(have, caseOf({}), host)).toMatchObject({
      applicable: false,
      missing: ["childText"],
    });
    const skipping = caseOf({
      checks: [
        {
          type: "output_contains",
          text: "a",
          weight: 1,
          ifUnsupported: "skip",
        },
        { type: "judge", rubric: "r", weight: 1 },
      ],
    });
    expect(applicability(have, skipping, host)).toEqual({
      applicable: true,
      skipped: [0],
    });
  } finally {
    if (spec) spec.needs = before as never;
  }
  expect(
    applicability(
      have,
      caseOf({ requires: ["bin:git"], harnesses: ["h"], note: "only h" }),
      host,
    ),
  ).toEqual({ applicable: true, skipped: [] });
});

test("the host set holds the executables on PATH that the cases name", () => {
  const box = sandbox();
  const found = hostCapabilities(
    [
      caseOf({ requires: ["bin:git", "bin:definitely-missing"] }),
      caseOf({
        checks: [
          {
            type: "output_contains",
            text: "a",
            weight: 1,
            requires: ["bin:tar"],
          },
        ],
      }),
    ],
    box.env,
  );
  expect([...found].sort()).toEqual(["bin:git", "bin:tar"]);
});

test("every capability has a one-sentence meaning, and the names are the fixed list", () => {
  expect(Object.keys(CAPABILITIES)).toHaveLength(23);
  for (const meaning of Object.values(CAPABILITIES)) {
    expect(meaning).toMatch(/^[A-Z].*\.$/);
  }
  expect(() => readNeeds(["subagents", "bin:a.b-c+d_e"], "f")).not.toThrow();
  expect(() => readNeeds(["bin:a b"], "f")).toThrow(UsageError);
});

test("the adapters declare what their parsers and fixtures show today", () => {
  const declared = Object.fromEntries(
    HARNESSES.map((h) => [h.id, [h.status, [...h.capabilities]]]),
  );
  expect(declared).toEqual({
    pi: ["scripted", ["toolOutputs", "assistantText", "turnGrouping"]],
    "claude-code": [
      "real-model",
      [
        "subagents",
        "turnGrouping",
        "childCalls",
        "childText",
        "loadedReport",
        "skillListing",
        "isolated",
        "toolOutputs",
        "assistantText",
        "multiTurn",
        "resume",
        "clear",
      ],
    ],
    cursor: ["unverified", ["subagents"]],
    opencode: [
      "scripted",
      [
        "subagents",
        "toolOutputs",
        "assistantText",
        "toolDurations",
        "turnGrouping",
      ],
    ],
    codex: ["scripted", ["subagents", "toolOutputs", "assistantText"]],
  });
});

test("the documented example case needs git, and skips its subagent check where subagents are not seen", () => {
  const examples = path.resolve(import.meta.dirname, "../examples/cases");
  const [loaded] = loadCases(examples, "requires");
  const host = hostCapabilities(loaded ? [loaded] : []);
  expect(host.has("bin:git")).toBe(true);
  const [pi] = HARNESSES;
  expect(loaded && pi && applicability(pi, loaded, host)).toEqual({
    applicable: true,
    skipped: [2],
  });
  const [, claude] = HARNESSES;
  expect(loaded && claude && applicability(claude, loaded, host)).toEqual({
    applicable: true,
    skipped: [],
  });
  expect(loaded && pi && applicability(pi, loaded)).toMatchObject({
    applicable: false,
    missing: ["bin:git"],
  });
});

test("a case that names harnesses without a note is still not applicable elsewhere", () => {
  const verdict = applicability(
    harness(new Set()),
    caseOf({ harnesses: ["other"] }),
  );
  expect(verdict).toEqual({
    applicable: false,
    missing: [],
    reason: "the case names other harnesses",
  });
});
