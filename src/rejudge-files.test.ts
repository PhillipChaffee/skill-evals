import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { archiveRun, unpackArchive } from "./archive.js";
import { EXIT } from "./exit-codes.js";
import { NO_ARCHIVE } from "./rescore.js";
import { keptArchive, stageKept } from "./run-archive.js";
import type { RunPlan } from "./run-plan.js";
import type { SessionResult } from "./session.js";
import {
  FIXED,
  KEEP,
  NEVER,
  NOTES,
  REJUDGED,
  onlyRecord,
  plantGrader,
  scoreInto,
  scoredWith,
} from "./testing/rejudge.js";
import { PASS } from "./testing/judged.js";
import { seenBy } from "./testing/sandbox.js";
import { startsOf } from "./testing/suite.js";

test("rejudge without an archive lists the checks it did not re-score", async () => {
  const exists = { type: "file_exists", path: NOTES };
  const scored = await scoredWith([exists, FIXED]);
  expect(onlyRecord(scored.out).workspaceArchive).toBeUndefined();
  const added = { type: "file_exists", path: "other.txt" };
  scored.rewrite([exists, added, NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr).toContain(`file_exists ${NOTES}: ${NO_ARCHIVE}`);
  expect(ran.stderr).toContain(`file_exists other.txt: ${NO_ARCHIVE}`);
  const [kept, unscored, again] = onlyRecord(scored.out, REJUDGED).checks;
  // The old check keeps its old score; the new one has none, so the run is invalid; the pattern is scored again.
  expect(kept?.score).toBe(1);
  expect(kept?.reason).toBe(NO_ARCHIVE);
  expect(unscored?.score).toBeNull();
  expect(again?.score).toBe(0);
  expect(onlyRecord(scored.out, REJUDGED).score).toBeNull();
  expect(ran.status).toBe(EXIT.invalid);
});

test("a run with an archive re-scores its file checks", async () => {
  const scored = await scoredWith([{ type: "file_exists", path: NOTES }], {
    flags: [KEEP],
  });
  expect(onlyRecord(scored.out).workspaceArchive?.bytes).toBeGreaterThan(0);
  scored.rewrite([
    { type: "file_exists", path: "other.txt" },
    { type: "file_exists", path: NOTES },
    { type: "file_exists", path: NOTES, root: "home" },
  ]);
  const before = startsOf(scored.box);
  const ran = await scored.rejudge();
  expect(startsOf(scored.box)).toBe(before);
  expect(onlyRecord(scored.out, REJUDGED).checks.map((c) => c.score)).toEqual([
    0, 1, 0,
  ]);
  expect(ran.stderr).not.toContain(NO_ARCHIVE);
});

test("a command check runs again against the unpacked workspace, seed and grader", async () => {
  const command = (run: string) => ({ type: "command", run });
  const scored = await scoredWith([command("test -f notes.txt")], {
    flags: [KEEP],
  });
  plantGrader(scored);
  scored.rewrite([
    command(
      'test -f notes.txt && test -f "$SKILL_EVALS_GRADER_DIR/ok.txt" && test -f "$SKILL_EVALS_SEED_DIR/notes.txt" && test -d "$SKILL_EVALS_REMOTE_DIR"',
    ),
  ]);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(onlyRecord(scored.out, REJUDGED).checks[0]?.score).toBe(1);
});

test("the archive lacks every auth file, the grader and the temp names", async () => {
  const scored = await scoredWith([{ type: "file_exists", path: NOTES }], {
    flags: [KEEP],
    answer: null,
  });
  scored.box.write(".claude/.credentials.json", "secret-token");
  plantGrader(scored);
  const again = await scoreInto(scored, "second", [KEEP]);
  const record = onlyRecord(again);
  // The agent did see the login: the archive's lack of it is not an accident.
  expect(seenBy(record.finalText).credentials).toBe("secret-token");
  const archive = path.join(again, record.workspaceArchive?.path ?? "");
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  expect(names.some((name) => name.includes("credentials"))).toBe(false);
  expect(names.some((name) => name.includes("ok.txt"))).toBe(false);
  expect(names).toContain("workspace/notes.txt");
  expect(new Set(names.map((name) => name.split("/")[0]))).toEqual(
    new Set(["workspace", "seed", "remotes", "home", "home-seed.json"]),
  );
  const home = execFileSync("tar", ["-xOf", archive, "home-seed.json"], {
    encoding: "utf8",
  });
  expect(home).not.toContain("credentials");
  expect(
    execFileSync("tar", ["-xOf", archive, "seed/notes.txt"], {
      encoding: "utf8",
    }),
  ).toBe("planted\n");
  expect(record.workspaceArchive?.path).toBe(
    "claude-code/restate/subject1.workspace.tar",
  );
});

test("--keep-workspaces without tar is a usage error", async () => {
  const scored = await scoredWith([FIXED]);
  const ran = await scored.box.cli(
    ["score", "--subject", scored.subject, "--cases", scored.cases, KEEP],
    { PATH: "/nonexistent" },
  );
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("needs the system tar");
});

test("a run whose archive cannot be unpacked is kept and listed", async () => {
  const scored = await scoredWith([{ type: "file_exists", path: NOTES }], {
    flags: [KEEP],
  });
  const archive = path.join(
    scored.out,
    onlyRecord(scored.out).workspaceArchive?.path ?? "",
  );
  fs.writeFileSync(archive, "not a tar");
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr).toContain("cannot be unpacked");
  expect(onlyRecord(scored.out, REJUDGED).checks[0]).toMatchObject({
    score: 1,
  });
});

test("a run without a transcript file is kept and listed", async () => {
  const scored = await scoredWith([FIXED]);
  fs.rmSync(path.join(scored.out, onlyRecord(scored.out).transcriptFile ?? ""));
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr).toContain("has no transcript file");
  expect(onlyRecord(scored.out, REJUDGED).score).toBe(1);
});

test("inputHash ignores the checks, rubrics and grader, and follows what the agent sees", async () => {
  const scored = await scoredWith([FIXED]);
  const hashOf = async (name: string, flags: string[] = []) =>
    onlyRecord(await scoreInto(scored, name, flags)).inputHash;
  const first = onlyRecord(scored.out).inputHash;
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  scored.rewrite([NEVER, { type: "judge", rubric: "x", scale: "binary" }]);
  plantGrader(scored);
  scored.box.write("fake/judge/replies.json", [PASS]);
  expect(await hashOf("same")).toBe(first);
  expect(await hashOf("model", ["--model", "other"])).not.toBe(first);
  scored.box.write("cases/restate/workspace/more.txt", "more\n");
  expect(await hashOf("files")).not.toBe(first);
});

test("an archive that cannot be made is a warning and a record without an archive", () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const plan = {
    keepWorkspaces: true,
    outDir: "/nonexistent-out",
    harness: { authFiles: [] },
    caseDef: { id: "restate" },
  } as unknown as RunPlan;
  const ran = {
    workspace: "/nonexistent-workspace",
    home: "/nonexistent-home",
    seedDir: null,
    remoteDir: null,
    homeSeed: new Map(),
  } as unknown as SessionResult;
  const staged = stageKept(plan, ran);
  expect(staged).not.toBeNull();
  expect(keptArchive(plan, staged, "/nonexistent-out/stem")).toBeNull();
  const broken = { ...ran, homeSeed: null } as unknown as SessionResult;
  expect(stageKept(plan, broken)).toBeNull();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("could not be archived"),
  );
  expect(stageKept({ ...plan, keepWorkspaces: false }, ran)).toBeNull();
  expect(keptArchive(plan, null, "stem")).toBeNull();
  warn.mockRestore();
});

test("an archive without a seed or a remote directory still serves the file checks", async () => {
  const exists = { type: "file_exists", path: NOTES };
  const scored = await scoredWith([exists], { flags: [KEEP] });
  const file = path.join(
    scored.out,
    onlyRecord(scored.out).workspaceArchive?.path ?? "",
  );
  // A workspace that is gone and a home that is a plain directory: the archive still has both.
  const lone = scored.box.write("lone/notes.txt", "kept\n");
  archiveRun(
    {
      workspace: path.dirname(lone),
      seedDir: null,
      remoteDir: null,
      home: path.join(scored.box.root, "missing-home"),
      homeSeed: new Map(),
      authFiles: [],
    },
    file,
  );
  const unpacked = unpackArchive(file);
  expect(unpacked.seedDir).toBeNull();
  expect(unpacked.remoteDir).toBeNull();
  expect(fs.existsSync(unpacked.home)).toBe(true);
  unpacked.dispose();
  scored.rewrite([exists, { type: "file_exists", path: "absent.txt" }]);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(
    onlyRecord(scored.out, REJUDGED).checks.map((one) => one.score),
  ).toEqual([1, 0]);
});
