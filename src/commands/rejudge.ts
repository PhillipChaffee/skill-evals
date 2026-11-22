import fs from "node:fs";
import path from "node:path";
import { exitCodeOf } from "../exit-codes.js";
import type { Evaluation, Results } from "../evaluate.js";
import type { Case } from "../cases.js";
import type { ExitCode } from "../exit-codes.js";
import type { Format } from "../report/formats.js";
import { lockDir } from "../lock.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { planRejudge } from "../rejudge-plan.js";
import { rejudged } from "../rejudge-results.js";
import { harnessOf, rescoreAll } from "../rejudge-run.js";
import { readSource, requireSource } from "../rejudge-source.js";
import { emitReports } from "../report/emit.js";
import { reportFormats } from "../report/formats.js";
import { renderReport } from "../report/markdown.js";
import { UsageError } from "../scope.js";
import { loadSelection, selectionOf } from "../select.js";
import { summaryOf } from "../summary.js";
import { writeAtomic } from "../store.js";
import type { Options } from "../usage.js";

/** Where a re-judged command writes its results when `--out` is not given. */
const REJUDGED_FILE = "results.rejudged.json";

/**
 * Tells whether two paths name one directory, links resolved.
 * @param first - A path.
 * @param second - A path.
 * @returns True when they are the same directory.
 */
function sameDir(first: string, second: string): boolean {
  const real = (target: string): string =>
    fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
  return real(first) === real(second);
}

/**
 * Writes what a re-judged command made.
 * @param made - The new results, the cases and what each harness ran, and the exit code.
 * @param made.results - The new results.
 * @param made.cases - The cases in report order.
 * @param made.applied - What each harness ran.
 * @param made.exit - The exit code of the new results.
 * @param where - The earlier command's directory, and `--out`.
 * @param where.dir - The earlier command's directory.
 * @param where.out - Another directory for the full set; null for `results.rejudged.json` beside the earlier results.
 * @param where.formats - The report formats of the config, which only `--out` writes.
 */
function write(
  made: {
    results: Results;
    cases: Case[];
    applied: Record<string, Case[]>;
    exit: ExitCode;
  },
  where: { dir: string; out: string | null; formats: Format[] },
): void {
  const { results, exit } = made;
  const evaluation = (outDir: string): Evaluation => ({
    ...results,
    exit,
    cases: made.cases,
    applied: made.applied,
    outDir,
  });
  if (where.out === null) {
    const file = path.join(where.dir, REJUDGED_FILE);
    writeAtomic(file, results);
    console.error(`skill-evals: wrote ${file}`);
    console.log(renderReport(evaluation(where.dir)));
    return;
  }
  writeAtomic(path.join(where.out, "results.json"), results);
  writeAtomic(path.join(where.out, "summary.json"), summaryOf(results, exit));
  emitReports(evaluation(where.out), where.formats);
}

/**
 * Re-scores the runs of a directory that this command holds, and writes the result.
 * @param dir - The earlier command's output directory, locked.
 * @param out - `--out`, or null.
 * @param given - The options after the config file was applied, and the report formats.
 * @param given.options - The options after the config file was applied.
 * @param given.formats - The report formats.
 * @returns The exit code of the new results.
 */
async function rejudgeIn(
  dir: string,
  out: string | null,
  given: { options: ReturnType<typeof withConfig<Options>>; formats: Format[] },
): Promise<number> {
  const { options } = given;
  const source = readSource(dir);
  const all = loadSelection(
    options.cases,
    { heldout: true },
    { lenient: options.lenient ?? source.results.meta.lenient ?? false },
  );
  const plan = planRejudge(source.results, {
    all,
    selection: selectionOf(options),
    harnesses: source.results.harnesses.map((id) => ({
      harness: harnessOf(id),
    })),
  });
  if (plan.unhashed > 0) {
    console.error(
      `skill-evals: warning: ${String(plan.unhashed)} runs have no inputHash, because they were stored before it existed; whether their case changed beyond its checks could not be told, so they were re-scored`,
    );
  }
  const rescored = await rescoreAll(source, plan, options);
  const made = rejudged({
    source: source.results,
    records: rescored.records,
    live: plan.live,
    ran: plan.ran,
    judge: rescored.judge,
    lenient: rescored.lenient,
    hashes: plan.hashes,
  });
  const exit = exitCodeOf(made.results, made.results.maxInvalid);
  write({ ...made, exit }, { dir, out, formats: given.formats });
  for (const note of rescored.notes) console.error(`skill-evals: ${note}`);
  return exit;
}

/**
 * Refuses an `--out` that already holds results, which the new ones would overwrite, and creates it otherwise.
 * @param out - The directory.
 * @throws {UsageError} When it holds `results.json` or `results.jsonl`.
 */
function requireEmpty(out: string): void {
  for (const name of ["results.json", "results.jsonl"]) {
    if (fs.existsSync(path.join(out, name))) {
      throw new UsageError(
        `--out ${out} already holds ${name}; choose a directory without results, because rejudge never overwrites them`,
      );
    }
  }
  fs.mkdirSync(out, { recursive: true });
}

/**
 * The `rejudge` command: scores the runs of an earlier command again, against the cases as they are now, without
 * starting the agent. It reads the directory under its lock and never changes `results.json` or `results.jsonl` in it.
 * @param options - The command line's options.
 * @param project - Where the config file and the default cases directory are.
 * @param args - The earlier command's output directory.
 * @returns The exit code, from `exitCodeOf`, over the re-scored results.
 * @throws {UsageError} For a directory that is not an output directory, `--out` equal to it, or a judge or decision
 *   model that is not set up.
 */
export async function rejudge(
  options: Options,
  project: Project,
  args: string[],
): Promise<number> {
  const dir = path.resolve(project.cwd, String(args[0]));
  const { outDir } = options;
  const out = outDir === undefined ? null : path.resolve(project.cwd, outDir);
  if (outDir !== undefined && out !== null && sameDir(out, dir)) {
    throw new UsageError(
      `--out ${outDir} is the directory being re-judged; leave --out out to write ${REJUDGED_FILE} beside its results, or name another directory`,
    );
  }
  const inside = path.relative(dir, out ?? dir);
  if (out !== null && !inside.startsWith("..") && !path.isAbsolute(inside)) {
    throw new UsageError(
      `--out ${String(outDir)} is inside the directory being re-judged; name a directory outside it`,
    );
  }
  requireSource(dir);
  const merged = withConfig(project, options);
  const formats = reportFormats(merged);
  const release = lockDir(dir);
  let releaseOut = (): void => undefined;
  try {
    if (out !== null) {
      requireEmpty(out);
      releaseOut = lockDir(out);
    }
    return await rejudgeIn(dir, out, { options: merged, formats });
  } finally {
    releaseOut();
    release();
  }
}
