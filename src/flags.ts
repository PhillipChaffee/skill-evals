import { readDecimal } from "./decimal.js";
import type { Options } from "./usage.js";
import { SAFETY_FLAGS } from "./flags-safety.js";
import { SELECT_FLAGS } from "./flags-select.js";
import { SUBJECT_FLAGS } from "./flags-subjects.js";

/** One flag: how its text becomes an option, and what the help text and the docs say about it. */
export interface FlagSpec {
  /** The option the flag sets; its own name when absent. */
  as?: keyof Options;
  /** Converts the text; it stays text when absent. */
  read?: (text: string) => number;
  /**
   * How the flag takes its value. "text" (the default) takes one value, "list" may be given again and holds every
   * value, split at commas, and "switch" takes no value and sets its option to true.
   */
  kind?: "text" | "list" | "switch";
  /** What stands for the value after the flag, as in `--reps <n>`. Empty for a switch. */
  value: string;
  /** What the flag sets, in one sentence. */
  description: string;
  /** What applies when the flag is absent. */
  default: string;
  /** The default in a command where it differs, by the command's name. */
  defaultIn?: Record<string, string>;
}

export const FLAGS = {
  ...SUBJECT_FLAGS,
  ...SAFETY_FLAGS,
  harness: {
    value: "ids|all",
    description: "Comma-separated harness ids.",
    default: "the first installed one",
    defaultIn: { check: "all" },
  },
  ...SELECT_FLAGS,
  json: {
    kind: "switch",
    value: "",
    description:
      "Print the result as JSON, an array with one entry for each harness: its id, whether it is installed, its adapter status, whether the probe ran and why not, a boolean for each capability, what it reported as loaded, whether the subject loaded, and the counts of skills, agents, rules, hooks fired and MCP servers the probe saw (null where the harness cannot report them), instead of the table.",
    default: "off: a table",
  },
  targets: {
    kind: "switch",
    value: "",
    description:
      "Print the coverage table: for each target skill, how many selected cases name it.",
    default: "off",
  },
  cases: {
    kind: "list",
    value: "dirs",
    description:
      "The directories that hold the cases. Repeat the flag or separate directories with commas. With more than one, each case id starts with the name of its directory and a slash, and two directories may not have the same name.",
    default: "evals/cases in the project",
  },
  "heldout-cases": {
    as: "heldoutCases",
    kind: "list",
    value: "dirs",
    description:
      "Directories whose every case is held out: its cases load only with --heldout, and the agent never sees the directory. Repeat the flag or separate directories with commas. When more than one directory is in use in all, ids are prefixed as for --cases.",
    default: "none",
  },
  reps: {
    read: readDecimal,
    value: "n",
    description: "Runs for each subject and case.",
    default: "3",
  },
  jobs: {
    read: readDecimal,
    value: "n",
    description:
      "How many runs may be in flight at once. A positive integer. Each run has its own home, workspace and copy of the subject. results.json lists the records in plan order whatever order the runs end in; results.jsonl and the progress lines follow the order they end in.",
    default: "1",
  },
  retries: {
    read: readDecimal,
    value: "n",
    description:
      "Tries after the first for a run that failed for a reason that is not the agent's: a harness crash (a non-zero exit with no final event), a rate limit (the adapter says so), or a timeout before the harness produced any agent event (its opening init event does not count). A non-negative integer. A rate-limited run waits 30 seconds times its attempt number first. A setup failure, an isolation breach, any other invalid run and a low score are never retried. The run record's attempts lists the error, cost (null when none was reported) and duration of each earlier attempt.",
    default: "0",
  },
  "max-cost": {
    as: "maxCost",
    read: readDecimal,
    value: "usd",
    description:
      "Stop starting runs once this command has spent this many US dollars, summing agent, judge and decision costs over the attempts it made; reused runs are not counted. A positive number. Runs in flight finish, with their judged and decision checks skipped, so they are invalid and --resume repeats them. The command exits 4. A usage error when a selected harness, the judge or a decision check reports no cost.",
    default: "no limit",
  },
  "max-duration": {
    as: "maxDuration",
    read: readDecimal,
    value: "minutes",
    description:
      "Stop starting runs after this many minutes of wall time. A positive number; fractions are allowed. Runs in flight finish, with their judged and decision checks skipped. The command exits 4.",
    default: "no limit",
  },
  model: {
    value: "id",
    description: "Passed to the harness unchanged.",
    default: "the harness's own default",
  },
  "min-score": {
    as: "minScore",
    read: readDecimal,
    value: "0..1",
    description:
      "The lowest suite score that passes. The command exits 1 when the suite score of the subject (B for run) is lower.",
    default: "no bar",
  },
  "min-delta": {
    as: "minDelta",
    read: readDecimal,
    value: "-1..1",
    description:
      "The least score difference, B minus A, that the suite must show, on the suite delta and not on its interval. The command exits 1 when the delta is lower. A negative number lets B score lower by at most that much. A case's own minDelta is the same bar for that case. Only run compares two subjects: with score it is a usage error.",
    default: "no bar",
  },
  noise: {
    value: "file",
    description:
      'A noise.json that calibrate wrote. A delta that is no larger than the noise it records for its case, or for the suite, reads "within noise", whatever its interval. A case that the file does not list is judged by its interval alone, and the report says so. A file of the wrong shape is a usage error.',
    default: "none: the interval alone decides",
  },
  seed: {
    read: readDecimal,
    value: "n",
    description:
      "The seed of the bootstrap behind every interval, a positive integer up to 4294967295. The same runs and the same seed give the same report, byte for byte. results.json records it.",
    default: "1",
  },
  "max-invalid": {
    as: "maxInvalid",
    read: readDecimal,
    value: "fraction",
    description:
      "The share of the planned runs that may be invalid, from 0 to 1. The command exits 3 only when the invalid runs divided by the planned runs of the cases that apply are greater than this. A run that did not run because --max-cost or --max-duration stopped the command is not invalid.",
    default: "0: any invalid run exits 3",
  },
  report: {
    kind: "list",
    value: "formats",
    description:
      "The report formats to write: md, json, junit or html. Repeat the flag or separate formats with commas. md goes to standard output, and only when it is listed. The others go to report.json, report.xml (JUnit) and report.html in the output directory. summary.json is always written there.",
    default: "md",
  },
  "judge-harness": {
    as: "judgeHarness",
    value: "id",
    description: "The harness that scores judged checks.",
    default: "the harness under test",
    defaultIn: { rejudge: "the judge harness of the earlier command" },
  },
  "judge-model": {
    as: "judgeModel",
    value: "id",
    description: "The model that scores judged checks.",
    default: "the value of --model",
    defaultIn: { rejudge: "the judge model of the earlier command" },
  },
  "judge-api": {
    as: "judgeApi",
    value: "kind",
    description:
      "Ask the judge model over this API and start no harness process for it. Only anthropic. --judge-harness is then ignored.",
    default: "a harness session",
    defaultIn: { rejudge: "the judge path of the earlier command" },
  },
  "judge-url": {
    as: "judgeUrl",
    value: "url",
    description: "The base URL of the judge API.",
    default: "the provider's own",
  },
  "decision-model": {
    as: "decisionModel",
    value: "id",
    description: "The decision model that scores decision checks.",
    default: "none",
  },
  "decision-url": {
    as: "decisionUrl",
    value: "url",
    description: "The base URL of the decision model's API.",
    default: "the provider's own",
  },
  "decision-timeout": {
    as: "decisionTimeout",
    read: readDecimal,
    value: "seconds",
    description:
      "How long one request to the decision model may take. A positive integer.",
    default: "60",
  },
  lenient: {
    kind: "switch",
    value: "",
    description:
      "Drop a key that a case file does not take, and warn, instead of failing. Keys that start with x- are always kept.",
    default: "off: an unknown key is an error",
    defaultIn: { rejudge: "what the earlier command used" },
  },
  deep: {
    kind: "switch",
    value: "",
    description:
      "Also run the setup steps of each case in a throwaway directory, and look for blinding words in the paths they make. Plain validate never runs a setup step and looks only at the files the case holds. --deep runs the suite's shell commands with your permissions, in a throwaway directory, and each step's timeoutSeconds still applies.",
    default: "off: setup is not run",
  },
  isolated: {
    kind: "switch",
    value: "",
    description:
      "Start the harness with nothing loaded but the subject, and mark a run invalid when the harness reports anything else as loaded. Only harnesses that declare the isolated capability take it.",
    default: "off: the harness loads what its settings say",
  },
  "history-mode": {
    as: "historyMode",
    value: "native|preamble",
    description:
      "How a case's history.json reaches the agent. preamble renders it as a block in front of the first message, which every harness can do. native writes it as the harness's own session and resumes it, and only a harness that declares historyNative can: where it is forced on one that cannot, a case with a history is not applicable. Each run record keeps the mode. Results of the two modes are not comparable.",
    default: "each harness's own, which is preamble for every harness today",
  },
  "keep-workspaces": {
    as: "keepWorkspaces",
    kind: "switch",
    value: "",
    description:
      "After a run's checks, archive its workspace, the seed it started from, its remote directory and its throwaway home as <run>.workspace.tar in the output directory, with the system tar. The harness's login files are left out of the home, and the grader's copy is never in it. results.json records each archive as workspaceArchive. rejudge reads the archive to score the checks that need files again. Needs tar on PATH.",
    default: "off: no archive",
  },
  kind: {
    value: "kind",
    description:
      "The kind of case init writes: trigger, negative, behaviour, pressure, agent, outcome or prose.",
    default: "none: init needs it",
  },
  rep: {
    read: readDecimal,
    value: "n",
    description:
      "Which rep of the case show prints, counted from 1. A positive integer.",
    default: "1",
  },
  out: {
    as: "outDir",
    value: "dir",
    description:
      "Where results go. A fresh run starts an empty results.jsonl there.",
    default: "a new temp directory",
    defaultIn: { rejudge: "results.rejudged.json beside the earlier results" },
  },
  resume: {
    value: "dir",
    description:
      "Continue the earlier command whose output directory this is. It implies --out and must name the same directory as --out when both are given. A run whose key matches a valid record in results.jsonl is not repeated; every other run is made and added. It also turns the judge cache on.",
    default: "none: a fresh run",
  },
  strict: {
    kind: "switch",
    value: "",
    description:
      "Turn any warning at the top of the diff into exit code 2. Without it diff informs and exits 0.",
    default: "off",
  },
  "dry-run": {
    as: "dryRun",
    kind: "switch",
    value: "",
    description:
      "Print what the command would run, as plan does, and exit 0. It starts no harness and writes nothing.",
    default: "off",
  },
} satisfies Record<string, FlagSpec>;
/** The name of a flag, without its dashes. */
export type Flag = keyof typeof FLAGS;
