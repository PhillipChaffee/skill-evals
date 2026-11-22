import path from "node:path";
import { expect, test } from "vitest";
import { fakeBwrap } from "./testing/os-sandbox.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { scoreSubject } from "./testing/runs.js";
import { SUMMARY, startsOf } from "./testing/suite.js";
import { GET_ISSUE, plantLookup } from "./testing/mcp.js";
import { loadCases } from "./cases.js";
import { inputHash } from "./input-hash.js";

const NONE = "none";
const ON_LINUX = process.platform === "linux";

/**
 * Plants cases that the fake harness passes, each with its own keys.
 * @param box - The sandbox.
 * @param cases - Case id to the keys of its case file besides `checks`.
 * @returns The cases directory.
 */
function plantWith(
  box: ReturnType<typeof sandbox>,
  cases: Record<string, Record<string, unknown>>,
): string {
  for (const [id, more] of Object.entries(cases)) {
    box.write(`cases/${id}/prompt.md`, `do ${id}\n`);
    box.write(`cases/${id}/case.json`, { checks: [SUMMARY], ...more });
  }
  return path.join(box.root, "cases");
}

const reasonsOf = (out: string) =>
  Object.fromEntries(
    readResults(out).notApplicable.map((one) => [one.caseId, one.reason]),
  );

test("--sandbox without a backend exits 2", async () => {
  const box = sandbox();
  const cases = plantWith(box, { open: {} });
  const ran = await scoreSubject(box, {
    subject: NONE,
    cases,
    flags: ["--sandbox"],
  });
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain(
    "no sandbox backend found (looked for bwrap, sandbox-exec)",
  );
  expect(startsOf(box)).toBe(0);
});

test("network off without --sandbox is not applicable", async () => {
  const box = sandbox();
  const cases = plantWith(box, {
    open: {},
    shut: { network: "off" },
    narrow: { network: "provider-only" },
  });
  const out = path.join(box.root, "results");
  const ran = await scoreSubject(box, { subject: NONE, cases, out });
  expect(ran.status).toBe(0);
  expect(ran.records.map((record) => record.caseId)).toEqual(["open"]);
  expect(startsOf(box)).toBe(1);
  expect(reasonsOf(out)).toEqual({
    shut: "network off needs --sandbox",
    narrow: "network provider-only needs --sandbox",
  });
});

test.skipIf(!ON_LINUX)(
  "under --sandbox a case runs wrapped with its own network, and provider-only is not applicable",
  async () => {
    const box = sandbox();
    const bwrap = fakeBwrap(box);
    const cases = plantWith(box, {
      open: {},
      shut: { network: "off" },
      narrow: { network: "provider-only" },
    });
    const out = path.join(box.root, "results");
    const ran = await scoreSubject(box, {
      subject: NONE,
      cases,
      out,
      flags: ["--sandbox"],
    });
    expect(ran.status).toBe(0);
    expect(ran.records.map((record) => record.caseId)).toEqual([
      "open",
      "shut",
    ]);
    expect(reasonsOf(out)).toEqual({
      narrow: "the sandbox cannot enforce provider-only",
    });
    const [open, shut] = bwrap.starts();
    expect(open).toContain("--share-net");
    expect(shut).not.toContain("--share-net");
    for (const args of [open, shut]) {
      expect(args).toContain("--unshare-all");
      const binds = (args ?? []).flatMap((word, at) =>
        word === "--bind"
          ? [path.basename(args?.[at + 1] ?? "").split("-")[0]]
          : [],
      );
      // The workspace, the throwaway home, the run's temp directory and the fixture remotes; nothing else is writable.
      expect(binds).toEqual(["proj", "home", "tmp", "store"]);
      // Order: / read-only first, every mask, then /dev, and only then the writable binds.
      const first = (word: string): number => (args ?? []).indexOf(word);
      const last = (word: string): number => (args ?? []).lastIndexOf(word);
      expect(
        (args ?? []).slice(first("--ro-bind"), first("--ro-bind") + 3),
      ).toEqual(["--ro-bind", "/", "/"]);
      expect(first("--ro-bind")).toBeLessThan(first("--tmpfs"));
      expect(last("--tmpfs")).toBeLessThan(first("--dev"));
      expect(first("--dev")).toBeLessThan(first("--bind"));
      expect(args).toContain("/tmp");
    }
    expect(shut?.join(" ")).toContain("do shut");
  },
);

test("setup steps and command checks run outside the sandbox", async () => {
  if (!ON_LINUX) return;
  const box = sandbox();
  const bwrap = fakeBwrap(box);
  box.write("cases/steps/prompt.md", "do steps\n");
  box.write("cases/steps/case.json", {
    setup: [{ run: "echo ready > ready.txt" }],
    checks: [SUMMARY, { type: "command", run: "test -f ready.txt" }],
  });
  const ran = await scoreSubject(box, {
    subject: NONE,
    cases: path.join(box.root, "cases"),
    flags: ["--sandbox"],
  });
  expect(ran.records[0]?.score).toBe(1);
  // One start of the harness, and nothing else went through bwrap.
  expect(bwrap.starts()).toHaveLength(1);
});

test("network counts in the input hash only when the case sets it", () => {
  const box = sandbox();
  const cases = plantWith(box, { plain: {}, shut: { network: "off" } });
  const [plain, shut] = loadCases(cases);
  if (!plain || !shut) throw new Error("two cases were planted");
  const run = { harness: "claude-code", model: undefined };
  expect(plain.network).toBeUndefined();
  expect(inputHash({ ...plain, network: undefined }, run)).toBe(
    inputHash(plain, run),
  );
  expect(inputHash(shut, run)).not.toBe(
    inputHash({ ...shut, network: undefined }, run),
  );
});

test.skipIf(!ON_LINUX)(
  "under --sandbox the mock log is bound writable after the read-only directory around it",
  async () => {
    const box = sandbox();
    const bwrap = fakeBwrap(box);
    const ran = await scoreSubject(box, {
      subject: NONE,
      cases: plantLookup(box, [GET_ISSUE]),
      flags: ["--sandbox"],
    });
    expect(ran.records[0]?.score).toBe(1);
    const [args = []] = bwrap.starts();
    const logAt = args.findIndex((word) => word.endsWith("/calls.log"));
    const dir = path.dirname(args[logAt] ?? "");
    const dirAt = args.findIndex(
      (word, at) => word === dir && args[at - 1] === "--ro-bind",
    );
    expect(args[logAt - 1]).toBe("--bind");
    expect(dirAt).toBeGreaterThan(0);
    expect(logAt).toBeGreaterThan(dirAt);
    expect(path.basename(dir)).toMatch(/^svc-/);
  },
);

test.skipIf(!ON_LINUX)(
  "a run made without the sandbox is not reused by --resume --sandbox",
  async () => {
    const box = sandbox();
    const bwrap = fakeBwrap(box);
    const cases = plantWith(box, { open: {} });
    const out = path.join(box.root, "results");
    const plain = await scoreSubject(box, { subject: NONE, cases, out });
    expect(plain.status).toBe(0);
    expect(bwrap.starts()).toHaveLength(0);
    const sandboxed = await scoreSubject(box, {
      subject: NONE,
      cases,
      out,
      flags: ["--sandbox", "--resume", out],
    });
    expect(sandboxed.status).toBe(0);
    // The agent ran again, inside the sandbox, and the same sandbox is reused by the next resume.
    expect(startsOf(box)).toBe(2);
    expect(bwrap.starts()).toHaveLength(1);
    const again = await scoreSubject(box, {
      subject: NONE,
      cases,
      out,
      flags: ["--sandbox", "--resume", out],
    });
    expect(again.status).toBe(0);
    expect(startsOf(box)).toBe(2);
  },
);

test.skipIf(!ON_LINUX)(
  "a sandboxExpose entry that does not exist exits 2 before any run",
  async () => {
    const box = sandbox();
    fakeBwrap(box);
    box.write("skill-evals.config.json", {
      sandboxExpose: [path.join(box.root, "missing")],
    });
    const ran = await scoreSubject(box, {
      subject: NONE,
      cases: plantWith(box, { open: {} }),
      flags: ["--sandbox"],
    });
    expect(ran.status).toBe(2);
    expect(ran.stderr).toMatch(
      /sandboxExpose: ".*missing" must be an absolute path that exists/,
    );
    expect(startsOf(box)).toBe(0);
    box.write("skill-evals.config.json", { sandboxExpose: ["relative"] });
    const relative = await scoreSubject(box, {
      subject: NONE,
      cases: plantWith(box, { open: {} }),
    });
    expect(relative.stderr).toContain(
      '"sandboxExpose" needs absolute paths, not "relative"',
    );
  },
);
