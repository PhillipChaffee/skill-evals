import fs from "node:fs";
import { expect, test } from "vitest";
import { sandbox } from "../testing/sandbox.js";
import type { Sandbox } from "../testing/sandbox.js";

const USAGE_ERROR = 2;

/**
 * Plants a case with a prompt and the given case file.
 * @param box - The sandbox.
 * @param id - The case id.
 * @param file - The content of `case.json`.
 */
function plant(box: Sandbox, id: string, file: unknown): void {
  box.write(`evals/cases/${id}/prompt.md`, "say it\n");
  box.write(`evals/cases/${id}/case.json`, file);
}

/**
 * Reads the first JSON block of an explanation.
 * @param stdout - What `explain` printed.
 * @returns The parsed block.
 */
function block(stdout: string): Record<string, unknown> & {
  checks: Record<string, unknown>[];
} {
  const found = /```json\n(.*?)\n```/s.exec(stdout);
  return JSON.parse(found?.[1] ?? "{}") as never;
}

test("explain fills defaults", async () => {
  const box = sandbox();
  plant(box, "one", {
    checks: [
      { type: "tool_called", name: "Read" },
      { type: "tool_not_called", name: "Edit" },
      { type: "file_exists", path: "a.txt" },
      { type: "command", run: "true" },
      { type: "judge", rubric: "It is fine." },
    ],
  });
  const ran = await box.cli(["explain", "one"]);
  expect(ran.status, ran.stderr).toBe(0);
  const shown = block(ran.stdout);
  expect(shown["timeoutSeconds"]).toBe(600);
  expect(shown["onTimeout"]).toBe("invalid");
  expect(shown.checks[0]).toMatchObject({ type: "tool_called", min: 1 });
  expect(shown.checks[1]).toMatchObject({ min: 0, max: 0 });
  expect(shown.checks[2]).toMatchObject({ root: "workspace" });
  expect(shown.checks[3]).toMatchObject({ expectExit: 0, timeoutSeconds: 120 });
  expect(shown.checks[4]).toMatchObject({
    sees: ["final"],
    scale: "0-1",
    votes: 1,
  });
  expect(shown.checks[4]).not.toHaveProperty("maxChars");
});

test("explain lists the layers in order, the capabilities, and each installed harness, and starts none", async () => {
  const box = sandbox();
  box.write("evals/cases/_shared/base/a.txt", "a\n");
  plant(box, "layered", {
    fixtures: ["../_shared/base"],
    requires: ["bin:nothing-like-this"],
    checks: [{ type: "tool_called", name: "Read", sameTurn: true }],
  });
  box.write("evals/cases/layered/workspace/b.txt", "b\n");
  const ran = await box.cli(["explain", "layered"]);
  expect(ran.status, ran.stderr).toBe(0);
  const shown = block(ran.stdout);
  expect(shown["files"]).toMatchObject({
    layers: [
      { layer: "fixture", path: "_shared/base" },
      { layer: "workspace", path: "layered/workspace" },
    ],
    grader: null,
  });
  expect(shown["requiredCapabilities"]).toEqual([
    "bin:nothing-like-this",
    "turnGrouping",
  ]);
  expect(ran.stdout).toMatch(
    /- claude-code \(.*\): not applicable, needs bin:nothing-like-this/,
  );
  expect(fs.existsSync(box.started)).toBe(false);
});

test("explain says applicable, and which checks a harness skips", async () => {
  const box = sandbox();
  plant(box, "plain", { checks: [{ type: "file_exists", path: "a" }] });
  plant(box, "partial", {
    checks: [
      { type: "file_exists", path: "a" },
      {
        type: "file_exists",
        path: "b",
        requires: ["bin:nothing"],
        ifUnsupported: "skip",
      },
    ],
  });
  expect((await box.cli(["explain", "plain"])).stdout).toMatch(
    /- claude-code \(.*\): applicable\n/,
  );
  expect((await box.cli(["explain", "partial"])).stdout).toMatch(
    /applicable, skipping checks #2/,
  );
});

test("explain lists the variants of a case, and takes one by its full id", async () => {
  const box = sandbox();
  plant(box, "vary", {
    checks: [{ type: "file_exists", path: "a" }],
    variants: [
      { id: "plain", promptAppend: "now" },
      { id: "secret", prompt: "hidden", heldout: true },
    ],
  });
  const all = await box.cli(["explain", "vary"]);
  expect(all.stdout).toContain("2 variants: `vary@plain`, `vary@secret`");
  expect(all.stdout).toContain("## vary@secret (held out)");
  const one = await box.cli(["explain", "vary@plain"]);
  expect(one.stdout).not.toContain("vary@secret");
});

test("explain with an unknown id exits 2 and lists the cases that exist", async () => {
  const box = sandbox();
  plant(box, "real", { checks: [{ type: "file_exists", path: "a" }] });
  const ran = await box.cli(["explain", "nope"]);
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toMatch(/no case "nope".*cases: real/);
  const glob = await box.cli(["explain", "**"]);
  expect(glob.status).toBe(USAGE_ERROR);
});

test("explain says so when no harness is installed", async () => {
  const box = sandbox();
  plant(box, "real", { checks: [{ type: "file_exists", path: "a" }] });
  const ran = await box.cli(["explain", "real"], {
    SKILL_EVALS_BIN_CLAUDE_CODE: "",
  });
  expect(ran.stdout).toContain("- no harness is installed");
});
