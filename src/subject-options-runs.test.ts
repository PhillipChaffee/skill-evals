import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, skillsFolder } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";
import { startsOf } from "./testing/suite.js";
import {
  BRO_LOADED,
  SUMMARY_CHECK,
  compared,
  ruggedKit,
} from "./testing/variants.js";

const BAR = "--bar-subject";
const ONE_REP = ["--reps", "1"];
const STEADY = "home/.claude/rules/steady.md";

/**
 * Plants a folder with a skill and a rules directory, and a case that every run passes.
 * @param box - The sandbox.
 * @returns The absolute path of the folder.
 */
function ruledFolder(box: Sandbox): string {
  const folder = skillsFolder(box, "mine", { bro: "# bro\n" });
  box.write("mine/rules/steady.md", "stay steady\n");
  plantCase(box, [SUMMARY_CHECK]);
  return folder;
}

test("--bar-subject moves the pass bars to the subject it names", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const flags = [...ONE_REP, "--min-score", "0.9"];
  const subjects = `good=${kit},bad=none,fine=${kit}`;
  // Without it the last subject is held to the bar, and it clears it.
  const last = await compared(box, subjects, flags);
  expect(last.ran.status, last.ran.stderr).toBe(0);
  const bar = [BAR, "bad"];
  const middle = await compared(box, subjects, [...flags, ...bar]);
  expect(middle.ran.status).toBe(1);
  const { belowBar, barSubject } = readResults(middle.out);
  expect(barSubject).toBe("bad");
  expect(belowBar).toEqual([
    "claude-code: suite score 0.00 (1 of 1 runs) does not reach --min-score 0.90",
  ]);
  const unknown = await compared(box, subjects, [BAR, "nope"]);
  expect(unknown.ran.status).toBe(2);
  expect(unknown.ran.stderr).toContain(
    "--bar-subject nope is not a subject label; the labels are good, bad, fine",
  );
});

test("a delta bar compares the bar subject with the baseline", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const subjects = `base=${kit},none=none,same=${kit}`;
  const flags = [...ONE_REP, "--min-delta", "0"];
  const last = await compared(box, subjects, flags);
  expect(last.ran.status, last.ran.stderr).toBe(0);
  const hurt = await compared(box, subjects, [...flags, ...[BAR, "none"]]);
  expect(hurt.ran.status).toBe(1);
  expect(readResults(hurt.out).belowBar[0]).toContain(
    "suite delta −1.00 does not reach --min-delta +0.00",
  );
  const onBaseline = await compared(box, subjects, [
    ...flags,
    ...[BAR, "base"],
  ]);
  expect(onBaseline.ran.status).toBe(2);
  expect(onBaseline.ran.stderr).toContain("is the baseline");
});

test("rules=on and rules=off differ in rules.installed", async () => {
  const box = sandbox();
  const folder = ruledFolder(box);
  box.write("skill-evals.config.json", { rules: "rules" });
  const subjects = `on=${folder}:rules=on,off=${folder}:rules=off,plain=${folder}`;
  const { ran, out } = await compared(box, subjects, ONE_REP);
  expect(ran.status, ran.stderr).toBe(0);
  const installed = (label: string) =>
    readResults(out).records.find((record) => record.subject === label)?.rules
      ?.installed;
  expect(installed("on")).toEqual([STEADY]);
  expect(installed("off")).toEqual([]);
  // With neither option the configured behaviour applies, which installs the configured rules.
  expect(installed("plain")).toEqual([STEADY]);
});

test("rules=on installs a rules/ directory that the config does not name, and no option leaves it alone", async () => {
  const box = sandbox();
  const folder = ruledFolder(box);
  const subjects = `on=${folder}:rules=on,plain=${folder}`;
  const { ran, out } = await compared(box, subjects, ONE_REP);
  expect(ran.status, ran.stderr).toBe(0);
  const [on, plain] = readResults(out).records;
  expect(on?.rules?.installed).toEqual([STEADY]);
  expect(plain?.rules).toBeUndefined();
});

test("agents=off leaves no agent registered", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const subjects = `all=${kit},off=${kit}:agents=off,some=${kit}:agents=except:help*`;
  const { ran, out } = await compared(box, subjects, ONE_REP);
  expect(ran.status, ran.stderr).toBe(0);
  const agents = (label: string) =>
    readResults(out).records.find((record) => record.subject === label)?.loaded
      .agents;
  expect(agents("all")).toEqual(["plugin:helper", "plugin:reviewer"]);
  expect(agents("off")).toEqual([]);
  expect(agents("some")).toEqual(["plugin:reviewer"]);
});

test("resume does not mix variants", async () => {
  const box = sandbox();
  const folder = ruledFolder(box);
  box.write("skill-evals.config.json", { rules: "rules" });
  const subjects = `x=${folder}:rules=off,y=${folder}`;
  const first = await compared(box, subjects, ONE_REP);
  expect(first.ran.status, first.ran.stderr).toBe(0);
  expect(startsOf(box)).toBe(2);
  const resumed = (given: string) =>
    compared(box, given, [...ONE_REP, "--resume", first.out]);
  // The same subjects reuse both runs.
  const same = await resumed(subjects);
  expect(same.ran.status, same.ran.stderr).toBe(0);
  expect(startsOf(box)).toBe(2);
  // X with another option is another subject, though its export is the same: it runs again, and y does not.
  const changed = await resumed(`x=${folder}:rules=on,y=${folder}`);
  expect(changed.ran.status, changed.ran.stderr).toBe(0);
  expect(startsOf(box)).toBe(3);
  expect(changed.ran.stderr.match(/\(reused\)/g)).toHaveLength(1);
  const { records } = readResults(first.out);
  expect(records.map((record) => record.rules?.installed.length)).toEqual([
    1, 1,
  ]);
  expect(records.map((record) => record.options)).toEqual([
    "rules=on",
    undefined,
  ]);
});

test("hooks=off in a run takes the hook out of every run's copy and leaves the source alone", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [{ type: "file_exists", path: "hook-config" }]);
  const command = 'test -e "$PLUGIN_DIR/hooks/hooks.json" && touch hook-config';
  box.write("fake/scripts/hook.json", {
    turns: [[{ call: { name: "Bash", input: { command }, exec: true } }]],
  });
  const subjects = `full=${kit},lean=${kit}:hooks=off`;
  const { ran, out } = await compared(box, subjects, ONE_REP);
  expect(ran.status, ran.stderr).toBe(0);
  const scores = readResults(out).records.map(({ subject, score }) => [
    subject,
    score,
  ]);
  expect(scores).toEqual([
    ["full", 1],
    ["lean", 0],
  ]);
  expect(fs.existsSync(path.join(kit, "hooks/hooks.json"))).toBe(true);
});
