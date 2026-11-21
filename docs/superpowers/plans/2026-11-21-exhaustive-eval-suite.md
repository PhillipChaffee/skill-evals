# Exhaustive Behavioural Eval Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `skill-evals` from "final answer, tool inputs, files" to a runner that can grade process claims (order, counts, subagents, transcripts, commands, multi-turn, rules, hooks, MCP) for a 388-case suite on five harnesses, without a runtime dependency and without changing how a 0.0.1 case scores.

**Architecture:** Three layers stay, each grows. (1) Adapters turn a harness stream into one normalized **transcript** of attributed events and declare a **capability set**; a case whose needs exceed that set is _not applicable_ on that harness. (2) The runner builds each run from a **copied subject**, a **layered workspace** with a seed snapshot, and a scrubbed environment, then hands checks one `Outcome`. (3) Checks are a table of typed specs that return a score and a reason; the docs, the JSON Schemas and strict-key validation are generated from that table.

**Tech Stack:** TypeScript 6, Node 22 built-ins only (`node:fs`, `node:child_process`, `node:crypto`, `node:util`, `fetch`), vitest 5 with a 95% coverage gate, the scripted fake harness in `test/fixtures/`.

**Spec:** `docs/superpowers/specs/2026-11-21-exhaustive-eval-suite.md`. This file does not exist yet: it is the task brief ("Extend `skill-evals` so that it can run a real, fairly exhaustive behavioural eval suite") that this plan was written from. Task 0 commits it. "Item N" and "Target case N" below are that brief's numbers. Executors read both files; the brief holds every JSON shape, and this plan does not repeat them.

## Global Constraints

- Zero runtime dependencies. `package.json` has no `dependencies` key and must not gain one. Node `>=22` built-ins only; no experimental API (`fs.globSync`, `path.matchesGlob` are out).
- Harness neutrality: no harness CLI flag, file layout or stream field outside `src/harnesses/<id>.ts`. A feature a harness cannot do is a missing capability, and the case is reported **not applicable** there. Never a silent skip, never a silent pass.
- Backward compatibility: every 0.0.1 case loads and scores the same. New keys are additive. `loadCases(casesDir, glob?)`, `evaluate`, `HARNESSES` and the current `results.json` fields keep their shape; new fields are added beside them. `src/package.test.ts` pins the export list and must be updated on purpose, never by accident.
- No model spend in tests. Every test runs the fake harness. One fake-harness script per new feature.
- Deterministic checks before judged ones.
- Every feature: reference docs with one complete valid example case (the example is validated by `src/docs/examples.test.ts`), and one line under `## Unreleased` in `CHANGELOG.md`.
- Unknown keys in `case.json` become a load error, except `x-` keys. `--lenient` exists for one release.
- Nothing the agent can read may reveal grader files, setup scripts, case ids, rubrics or the cases directory.
- A missing capability, a failed precondition and a failed setup step invalidate or exclude. Only agent behaviour scores.
- Windows stays unsupported.
- Every task ends green on `./run-gates.sh`. When its hygiene binaries are not installed, the floor is `npm run format:check && npm run typecheck && npm run lint && npm test && npm run knip && npm run lint:graph`.
- Generated files are regenerated, never hand-edited: `npm run docs:reference` rewrites the reference pages (and, from Task 7, `schema/*.json`).
- Commits are authored as the repository owner (see the user's git attribution rule); no tool attribution in PR text.
- One reviewable change per item. Do not start an item until the one before it is green. Order follows the brief's milestone table, not its numbering: 5, 10, 18a, 3, 8, 9, 1, 2, 4, 7, 13, 11, 12, 18b, 6, 14, 15, 16, 17, 19, 20.

## Verified baseline

The brief's table of 0.0.1 behaviour was checked against `main` at `182afab`. Every row holds, with these differences to know about:

| Area            | What the brief says                                           | What `main` has                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown keys    | Silently ignored at case and check level                      | True for `case.json`. `skill-evals.config.json` already rejects unknown keys (`src/project.ts`).                                                                                                                                                                                    |
| Check fields    | —                                                             | Every check field is a non-empty string (`readFields` in `src/cases.ts`). Numbers, booleans, lists and nested matchers need a typed field table first (Task 2).                                                                                                                     |
| Environment     | Child inherits everything minus `SKILL_EVALS_*`, `npm_*`, `_` | Also minus the decision model's key variable (`withhold`).                                                                                                                                                                                                                          |
| Per-check rates | "Not only weighted means"                                     | `src/report.ts` `checkRate` already prints a pass count per check under each case. Item 12 extends it; it does not start from nothing.                                                                                                                                              |
| Docs            | `docs/` not in the tarball                                    | `docs/` is an Astro site package. Reference pages under `docs/src/content/docs/reference/` are generated from the code by `src/docs/reference.ts`, and a test fails when a page is stale.                                                                                           |
| Help text       | No `--help`                                                   | Unreleased `main` generates usage text from `COMMANDS` and `FLAGS` (`src/usage.ts`), but only prints it with exit 2.                                                                                                                                                                |
| Pi              | —                                                             | The Pi adapter already starts with discovery off (`-ne -ns -np`), so it is the one harness that is close to `--isolated` today.                                                                                                                                                     |
| Subagents       | Flattened                                                     | The captured fixture `test/fixtures/claude-code-tools.stream.jsonl` shows child calls carry `parent_tool_use_id`; the parser drops it. The fixture's ids are scrubbed to one value and it holds no `user`/`tool_result` events, so attribution and tool outputs need a new capture. |
| `decision`      | Never run against the hosted endpoint                         | Confirmed by `docs/.../agents/verified.md`: run against self-hosted bison-1 only.                                                                                                                                                                                                   |

## Decisions

These are the brief's eight "decide before coding" questions, answered. Task 0 writes them into `docs/design/`. A reviewer who disagrees should say so before Task 2.

1. **Not applicable.** Applicability is decided per (harness, case), before any run, from `requires` plus what the case's checks imply. A not-applicable case has no runs, no score, and a row in the report's "Not applicable" list with the missing capabilities. It is never a pass and never a failure. Applicability is case-level: one check that needs a missing capability makes the whole case not applicable (rejected: per-check exclusion with re-normalized weights, because the case would then score differently per harness under one name). Each harness's suite score is over its own applicable set and is printed as `score (n of N cases)`. When more than one harness runs, the report adds a **common-set score** over the cases applicable to all of them; only that number is comparable across harnesses.
2. **Invalid versus zero.** Infrastructure and preconditions invalidate; agent behaviour scores. Invalid: harness error, time limit, setup step failed, precondition unmet, subject not loaded, anything unexpected loaded under `--isolated`, a judged or decision check with no usable answer. Scored: a `command` check that times out or cannot start (score 0 with the reason), hitting `maxTurns` (scored, `stoppedBy: "maxTurns"` shown), a mutated subject (scored, flagged). A time limit stays invalid because 0.0.1 treats it so.
3. **Isolation default.** The subject is always copied; there is no in-place mode. `--isolated` is opt-in in this release and the CI guide recommends it (rejected: default on, because a 0.0.1 suite on a machine with user-level settings would change scores without a case change).
4. **Transcript fidelity.** The full transcript is written to `<label><rep>.transcript.json`. In `results.json` a run record keeps `toolCalls` with inputs and no outputs, and `transcriptFile`. Any single `text`/`output` longer than 20,000 bytes is cut in the transcript's in-memory copy handed to the judge; the file on disk is never cut. Every cut records `bytes` (original size) and `truncated: true`.
5. **History.** Two modes: `native` (the adapter writes a session in the harness's own store and resumes it) and `preamble` (the history is rendered as a quoted block in front of turn 1). Each adapter declares which it does; the record keeps `historyMode`. `--history-mode preamble` forces the common mode for cross-harness comparison. Rejected: replaying history as real turns, because the model's replies would differ from the seeded ones and cost tokens.
6. **Turn limit.** The runner counts assistant turns in the stream as it arrives and stops the process group at the limit; the native flag is also passed where one exists. Hitting it scores the run. A harness without turn grouping records `maxTurnsEnforced: false` and the report says so; the case still runs, as it does in 0.0.1.
7. **`text_metrics`.** Not built in. `examples/graders/text-metrics.mjs` is a documented `command` grader.
8. **Judge path.** A direct API path (`src/judge-api.ts`, `fetch`, no harness process) is added and used when `judgeApi` is configured. A harness session stays the fallback and the default.

Two more, raised by the code:

- **Exit codes:** 0 pass, 1 a bar missed, 2 usage, 3 invalid runs above `--max-invalid` (default 0), 4 partial because a budget stopped the run, 130 interrupted. Today invalid runs exit 1; the migration note says so.
- **Version:** this ships as `0.1.0`.

## Review Focus

Inputs the brief implies and no acceptance test names. Each has a test in the task shown.

1. **A symlink that leaves its tree.** A link in `workspace/`, a shared fixture, `home/` or the subject that points at the cases directory or a `grader/` must not be followed into the agent's view, and a glob check must not follow a link out of the workspace. Expected: links are copied as links, a link whose target is outside its own tree is a load error, globs never traverse links. Tasks 4, 10, 13.
2. **The agent wrecks the run directory.** It deletes the workspace, leaves a background process, writes a multi-gigabyte file, or leaves unreadable files. Expected: the run still gets a record; file and command checks score 0 with a reason; hashing skips what it cannot read and says so; nothing crashes. Tasks 10, 12.
3. **Two writers, one file.** Parallel jobs finishing together, an interrupt in the middle of an append, and a resume that meets a truncated last line of `results.jsonl`. Expected: each line is whole or absent; a broken last line is dropped with a warning and its run repeats. Task 19.
4. **Hostile text.** Binary or invalid UTF-8 tool output, a 50 MB output, a regular expression that backtracks badly on it, a glob that matches ten thousand files. Expected: outputs are decoded with replacement, patterns run against capped text (documented cap), glob expansion is capped with an error that names the pattern. Tasks 10, 14, 15.
5. **Ids that collide with syntax.** A case directory whose name contains `@`, `,`, a leading `_` deeper in the path, or a case nested inside another case; a subject label equal to a variant id. Expected: `@` and `,` in a directory name are load errors, a directory under a case is never itself a case, labels are checked for uniqueness. Tasks 6, 7, 27.

## File Structure

Created (source):

| File                                                                                                      | Responsibility                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/checks/fields.ts`                                                                                    | The typed field table: each field's type, meaning, parser. Strict-key reading of one check.                                                   |
| `src/checks/index.ts`                                                                                     | `CHECKS` registry, `Check`, `Outcome`, `Verdict`, `checkVerdict`, `describeCheck`, `capabilitiesOf(check)`. Replaces `src/checks.ts`.         |
| `src/checks/output.ts`, `tools.ts`, `files.ts`, `skills.ts`, `transcript.ts`, `command.ts`, `observed.ts` | One file per family of check rules. `observed.ts` holds `subject_unchanged`, `hook_fired`, `context_injected`, `no_writes_outside_workspace`. |
| `src/matchers.ts`                                                                                         | `ToolMatcher`: parse, match one call, `by` scoping, quote a slice of the call list for a reason.                                              |
| `src/glob.ts`                                                                                             | `globToRegExp(glob)`, `expandGlob(root, glob, limit)`. Used by case selection, file checks, `subjectExclude`.                                 |
| `src/capabilities.ts`                                                                                     | `CAPABILITIES` (name → meaning), `applicability(harness, caseDef)`.                                                                           |
| `src/select.ts`                                                                                           | Tag and id selection of loaded cases; variant expansion.                                                                                      |
| `src/env.ts`                                                                                              | The child-environment allowlist.                                                                                                              |
| `src/isolate.ts`                                                                                          | Copy or `git archive` a subject, apply variants, hash it, diff it after a run.                                                                |
| `src/snapshot.ts`                                                                                         | Hash a tree, diff two snapshots into `ChangedFiles`.                                                                                          |
| `src/workspace.ts`                                                                                        | Build one run's directories: fixtures, workspace, setup, home seed, seed copy, grader dir, remote dir.                                        |
| `src/command.ts`                                                                                          | Run one shell command with the grader/setup environment; capture and truncate.                                                                |
| `src/transcript.ts`                                                                                       | `TranscriptEvent`, slicing by turn/scope/agent, truncation, compact rendering.                                                                |
| `src/skill-events.ts`                                                                                     | Derive `SkillEvent[]` from a transcript and a subject. Replaces `skillsLoaded` in `src/run.ts`.                                               |
| `src/turns.ts`                                                                                            | Drive the turns of one session through an adapter.                                                                                            |
| `src/history.ts`                                                                                          | Read `history.json`; render the preamble.                                                                                                     |
| `src/schedule.ts`                                                                                         | Job pool, budget, retries.                                                                                                                    |
| `src/store.ts`                                                                                            | `results.jsonl` append, atomic `results.json`/`summary.json`, run keys, resume lookup.                                                        |
| `src/stats.ts`                                                                                            | Bootstrap interval, noise floor, verdict of a delta.                                                                                          |
| `src/judge-api.ts`                                                                                        | The direct judge call.                                                                                                                        |
| `src/cache.ts`                                                                                            | Judge result cache by content hash.                                                                                                           |
| `src/blinding.ts`                                                                                         | The word list and the scans.                                                                                                                  |
| `src/os-sandbox.ts`                                                                                       | Backends for `--sandbox`.                                                                                                                     |
| `src/mcp/mock-server.ts`, `src/mcp/mocks.ts`                                                              | The stdio mock server (a second `bin`), and loading `mcp/` directories.                                                                       |
| `src/report/markdown.ts`, `json.ts`, `junit.ts`, `html.ts`                                                | One renderer per `--report` value. `src/report.ts` moves to `markdown.ts`.                                                                    |
| `src/commands/*.ts`                                                                                       | `validate`, `plan`, `init`, `explain`, `show`, `diff`, `rejudge`, `calibrate`. `src/cli.ts` keeps the table and the dispatcher only.          |
| `src/docs/schema.ts`                                                                                      | Writes `schema/case.schema.json` and `schema/config.schema.json` from the field and config tables.                                            |

Created (other): `schema/`, `docs/design/*.md` (five notes), `examples/cases/<check-type>/` (one per check type), `examples/graders/text-metrics.mjs`, `test/target/cases/` and `test/target/scripts/` (the twelve target cases), `docs/src/content/docs/guides/migrate-from-0-0-1.md`.

Modified throughout: `src/cases.ts`, `src/run.ts`, `src/session.ts`, `src/exec.ts`, `src/evaluate.ts`, `src/subject.ts`, `src/score.ts`, `src/probe.ts`, `src/usage.ts`, `src/project.ts`, `src/harnesses/*.ts`, `test/fixtures/fake-harness.mjs`, `src/testing/*.ts`, `package.json` (`files`, `bin`, `version`).

## Shared Vocabulary

Types that more than one task uses. A task's Interfaces block refers to these by name. All live where the table above says.

```ts
// src/harnesses/shared.ts
type ToolKind =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "web"
  | "skill"
  | "subagent"
  | "mcp"
  | "todo"
  | "question"
  | "other"; // mcp: Task 28; todo, question: Task 29
interface AgentRef {
  id: string;
  type: string;
  parent: string | null;
  depth: number;
} // depth 0 = main, id "main"
interface ToolCall {
  name: string;
  kind: ToolKind;
  input: unknown;
  index?: number;
  turn?: number;
  userTurn?: number;
  agent?: AgentRef;
  callId?: string;
} // optional: 0.0.1 records lack them
interface TranscriptEvent {
  index: number;
  turn: number | null;
  userTurn: number;
  role: "user" | "assistant" | "tool" | "system";
  agent: AgentRef;
  type: "text" | "tool_call" | "tool_result" | "hook" | "lifecycle";
  callId?: string;
  kind?: ToolKind;
  name?: string;
  input?: unknown;
  output?: string;
  text?: string;
  bytes?: number;
  truncated?: boolean;
  hook?: HookEvent;
}
interface Loaded {
  paths: string[] | null;
  skills: string[] | null;
  agents: string[] | null;
  rules: string[] | null;
  hooks: string[] | null;
  mcpServers: string[] | null;
} // null = this harness does not report it
interface Parsed {
  finalText: string;
  toolCalls: ToolCall[];
  transcript: TranscriptEvent[];
  tokens: Tokens | null;
  costUsd: number | null;
  loaded: Loaded;
  sessionId: string | null;
  askedUser: boolean | null;
  error: string | null;
}
type Capability = keyof typeof CAPABILITIES; // src/capabilities.ts
interface Harness {
  /* existing */ capabilities: ReadonlySet<Capability>;
  authEnv: string[];
  status: "real-model" | "scripted" | "unverified";
  historyMode: "native" | "preamble" | null;
}

// src/checks/index.ts
interface Verdict {
  score: number;
  reason?: string;
}
type Rule = (check: Check, outcome: Outcome) => Verdict | Promise<Verdict>;
interface Outcome {
  finalText: string;
  toolCalls: ToolCall[];
  transcript: TranscriptEvent[];
  skillsLoaded: string[];
  skillEvents: SkillEvent[];
  loaded: Loaded;
  workspace: string;
  home: string;
  seed: Snapshot;
  changed: ChangedFiles;
  subject: { dir: string | null; mutated: string[] };
  run: CommandContext;
}

// src/snapshot.ts
type Snapshot = Map<string, string>; // relative posix path -> sha256, links hashed by target text
interface ChangedFiles {
  created: string[];
  modified: string[];
  deleted: string[];
}
```

`CAPABILITIES` names, fixed here so every task spells them alike: `subagents`, `multiTurn`, `userInvoke`, `toolOutputs`, `assistantText`, `turnGrouping`, `childCalls`, `childText`, `rules`, `hooks`, `history`, `sessionStore`, `compact`, `clear`, `resume`, `mcp`, `skillListing`, `loadedReport`, `isolated`, `sandbox`. The brief's seven (`subagents`, `multiTurn`, `userInvoke`, `toolOutputs`, `turnGrouping`, `rules`, `hooks`) are a subset.

## Task Cycle

Every task below follows this cycle; its steps list only what is specific.

1. Write the listed tests. Run `npx vitest run <file> --coverage.enabled=false`. Expected: the new tests fail for the stated reason.
2. Implement the listed signatures.
3. Run the same command. Expected: pass.
4. Add the docs page section and its example case; run `npm run docs:reference`; add the changelog line.
5. Run the gates (Global Constraints). Expected: all green.
6. Commit with the message given.

Tests use the existing helpers: `sandbox()`, `plantCase()`, `plugin()`, `skillsFolder()`, `readResults()`, `tableRow()` from `src/testing/`, plus `script()` from Task 1.

---

## M0: groundwork

### Task 0: Commit the spec, the decisions and the design notes

**Files:**

- Create: `docs/superpowers/specs/2026-11-21-exhaustive-eval-suite.md` (the brief, verbatim)
- Create: `docs/design/capabilities-and-not-applicable.md`, `docs/design/subject-isolation.md`, `docs/design/transcript-model.md`, `docs/design/agent-attribution.md`, `docs/design/multi-turn-and-history.md`

- [ ] **Step 1:** Save the brief at the spec path. Run `npx prettier --write` on it.
- [ ] **Step 2:** Write the five notes. Each has four headings: `Decision`, `Why`, `Alternatives rejected`, `What it costs`. Content: the Decisions section above (1 → capabilities note; 3 → isolation; 4 → transcript; 5 and 6 → multi-turn; the `AgentRef` shape and the plugin-prefix rule → attribution; 2 goes in the capabilities note under "Invalid versus zero").
- [ ] **Step 3:** Gates, then `git commit -m "docs: record the spec and the five design decisions for the eval-suite work"`.

### Task 1: A scripted fake harness

Every later test needs the fake agent to produce a chosen transcript. Today it only loads skills the prompt names.

**Files:**

- Modify: `test/fixtures/fake-harness.mjs`, `src/testing/sandbox.ts`, `src/testing/plant.ts`
- Test: `src/testing/script.test.ts`

**Interfaces:**

- Produces: `script(box: Sandbox, name: string, script: FakeScript): string` in `src/testing/plant.ts`, which writes `<box.root>/fake/scripts/<name>.json`.
- Produces: `FakeScript = { match?: { prompt?: string; plugin?: boolean }; init?: Partial<InitEvent>; turns: FakeStep[][] }` and
  `FakeStep = { text: string } | { call: { name: string; input: unknown; output?: string; exec?: boolean; write?: { path: string; content: string } } } | { parallel: FakeStep[] } | { agent: { type: string; prompt: string; steps: FakeStep[] } } | { hook: { event: string; command: string; exit: number; context?: string } } | { fail: string } | { final: string }`.
- Semantics: the first script whose `match` fits the run is used; with none, the fake behaves exactly as today. `exec: true` on a `Bash` call runs `input.command` in the cwd and uses the real combined output and exit status as the tool result. `write` creates the file. `parallel` puts its calls in one assistant message (one `message.id`). `agent` emits an `Agent` tool call, then its steps with `parent_tool_use_id` set to that call's id. Every `tool_use` gets a unique id and is followed by a `user` event holding the matching `tool_result`. Turn `n` of `turns` answers the n-th prompt of a session.
- `sandbox()` no longer points `SKILL_EVALS_BIN_CLAUDE_CODE` at the shared fixture. It writes `<root>/bin/fake-agent.mjs`, a two-line launcher that sets `process.env.FAKE_DIR = "<root>/fake"` and imports the fixture. The fake reads `FAKE_JUDGE_DIR` as `$FAKE_DIR/judge` when the variable is unset. This keeps tests working after Task 3 scrubs the environment.

- [ ] **Step 1: Tests** in `src/testing/script.test.ts`:
  - `a script's calls reach the run record in order`: script with `text`, `Bash`, `Edit`; `score` one case; `readResults(...).records[0].toolCalls.map(c => c.name)` equals `["Bash", "Edit"]`.
  - `an exec call runs the command in the workspace`: `{ call: { name: "Bash", input: { command: "cat notes.txt" }, exec: true } }`; the stream file holds a `tool_result` containing `planted`.
  - `a run with no matching script behaves as before`: existing `Seen` report is the final text.
  - `match.plugin selects the arm`: two scripts, `plugin: true` and `plugin: false`; `run --a none --b <plugin>` gives each arm its own final text.
- [ ] **Step 2:** Implement. Keep the fixture a single `.mjs` file with no imports beyond Node built-ins.
- [ ] **Step 3:** Run the whole suite: `npm test`. Expected: every existing test passes unchanged.
- [ ] **Step 4:** `git commit -m "test: let the fake harness play a scripted transcript"`.

---

## M1: safe runs and an organisable suite (items 5, 10, 18a)

### Task 2 (item 10a): Typed check fields and strict keys

**Files:**

- Create: `src/checks/fields.ts`, `src/checks/index.ts`, `src/checks/output.ts`, `src/checks/tools.ts`, `src/checks/files.ts`, `src/checks/skills.ts`
- Delete: `src/checks.ts` (its content moves; update imports in `cases.ts`, `run.ts`, `report.ts`, `decision.ts`, `evaluate.ts`, `docs/reference.ts`)
- Modify: `src/cases.ts`, `src/usage.ts`, `src/cli.ts`, `src/project.ts`
- Test: `src/validation.test.ts`, `src/checks/fields.test.ts`

**Interfaces:**

- Produces: `type FieldType = "text" | "regex" | "flags" | "path" | "glob" | "kind" | "int" | "unit" | "bool" | "enum" | "texts" | "matcher" | "matchers" | "object"`.
- Produces: `FIELDS: Record<string, { type: FieldType; meaning: string; values?: readonly string[] }>` (the old `FIELD_MEANINGS` becomes its `meaning` column).
- Produces: `Spec = { fields: string[]; optional?: string[]; oneOf?: string[]; scores: string; note?: string; rule?: Rule; needs?: (check: Check) => Capability[] }`.
- Produces: `readCheck(raw: unknown, where: string, mode: { lenient: boolean }): Check` — replaces `parseCheck`. Unknown key → `UsageError` naming the key, the check type and its allowed keys, unless the key starts with `x-` (kept on the check) or `mode.lenient` (dropped, and the name returned in a warnings list).
- Produces: `CASE_KEYS: Record<string, { type: FieldType; meaning: string }>` in `src/cases.ts` — the allowed top-level keys, strict in the same way.
- Produces: `loadCases(casesDir: string, glob?: string, options?: { lenient?: boolean; onWarning?: (text: string) => void }): Case[]`.
- Produces: flag `--lenient` on `run`, `score`, `list`; config key `lenient: boolean`.
- `Rule` returns `Verdict` (Shared Vocabulary). In this task every existing rule is wrapped to return `{ score }`; reasons come in Task 9.
- `Case` gains `extensions: Record<string, unknown>` (the `x-` keys). Produces `Results.caseMeta: Record<string, { extensions: Record<string, unknown> }>` keyed by case id (Task 7 adds `tags`, `targets`, `guard` to it). `CheckResult` carries a check's own `x-` keys.

- [ ] **Step 1: Tests**
  - `a 0.0.1 case file loads to the same checks as before`: load `examples/cases/hello`; `expect(loaded.checks).toEqual(<the literal from today's loader>)`.
  - `an unknown check key is a load error that names it`: `{ type: "file_exists", path: "a", pth: "b" }` → `/unknown key "pth".*file_exists.*path/`.
  - `an unknown case key is a load error`: `{ checks: [...], timeoutSecond: 5 }` → `/unknown key "timeoutSecond"/`.
  - `an x- key is kept and written to results.json`: case `"x-owner": "ops"`; assert `readResults(out).caseMeta.restate.extensions["x-owner"] === "ops"`.
  - `--lenient loads the file and warns once per key on stderr`: status 0, stderr matches `/ignored unknown key "pth"/`.
  - `the messages of 0.0.1 validation errors are unchanged`: `weight: "2"` → `/weight must be a positive number/`; every assertion already in `src/validation.test.ts` passes untouched.
- [ ] **Step 2:** Implement. `REGEX_FIELDS` is derived from `FIELDS` (`type === "regex"`). `src/docs/reference.ts` reads `FIELDS` where it read `FIELD_MEANINGS`.
- [ ] **Step 3:** Docs: "Strict keys" section in `guides/write-a-case.md`; changelog; `git commit -m "feat: reject unknown keys in case files, keep x- keys, add --lenient"`.

### Task 3 (item 5a): A scrubbed child environment

**Files:**

- Create: `src/env.ts`; Test: `src/env.test.ts`
- Modify: `src/session.ts`, `src/project.ts`, `src/harnesses/*.ts` (each gains `authEnv`)

**Interfaces:**

- Produces: `childEnv(input: { home: string; base: NodeJS.ProcessEnv; harnessEnv: Record<string, string>; authEnv: string[]; pass: string[]; withhold: string[] }): Record<string, string>`.
- Allowlist (exact): `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TERM`, `TZ`, `LANG`, `LANGUAGE`, every `LC_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lower-case forms, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`; plus the adapter's `authEnv`; plus names in config `env: string[]`. `HOME` and the four `XDG_*` are set as today. `withhold` wins over everything.
- `authEnv` per adapter, initial values to confirm in Task 29: claude-code `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_*`-prefixed names are **not** globbed (list `AWS_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`); codex `OPENAI_API_KEY`, `OPENAI_BASE_URL`; opencode and pi: both provider sets; cursor `CURSOR_API_KEY`.
- Config key `env` is a list of exact variable names; a name matching `/^(SKILL_EVALS_|npm_)/` is a config error.

- [ ] **Step 1: Tests**
  - `a variable outside the allowlist does not reach the harness`: run with `SECRET_THING=1` in the sandbox env; a script step `{ call: { name: "Bash", input: { command: "env" }, exec: true } }`; the tool result lacks `SECRET_THING`.
  - `a name in config env passes`, `a harness auth variable passes`, `the decision key is still withheld when listed in env`.
  - `proxy and certificate variables pass in both cases`.
- [ ] **Step 2:** Implement; delete `childEnv` and `NAMES_THIS_TOOL` from `session.ts`.
- [ ] **Step 3:** Docs: `concepts/one-run.md` step 4, `reference/config.md` (generated), safety page. Migration note line: "a harness that needs a variable outside the allowlist needs it named in `env`". `git commit -m "feat: start the harness with an allowlisted environment"`.

### Task 4 (item 5b): Always run against a copy of the subject

**Files:**

- Create: `src/isolate.ts`, `src/snapshot.ts`, `src/glob.ts`, `src/checks/observed.ts`
- Modify: `src/subject.ts`, `src/run.ts`, `src/evaluate.ts`, `src/project.ts`
- Test: `src/isolate.test.ts`, `src/glob.test.ts`, `src/snapshot.test.ts`

**Interfaces:**

- Produces: `globToRegExp(glob: string): RegExp` — `*` (no `/`), `**` (any depth), `?`, `{a,b}`; anchored; a bare `*`-only glob keeps today's `--case` meaning.
- Produces: `expandGlob(root: string, glob: string, limit = 5000): string[]` — sorted relative posix paths, never follows links, throws `UsageError` naming the glob past the limit.
- Produces: `snapshot(dir: string): Snapshot`, `diffSnapshots(before: Snapshot, after: Snapshot): ChangedFiles`. Unreadable entries get the hash `"unreadable"`.
- Produces: `exportSubject(source: { dir: string; commit: string | null; repoRoot: string }, exclude: string[]): { dir: string; dispose: () => void }`. For a commit: `git -C <repoRoot> archive <commit> | tar -x -C <tmp>` (honours `export-ignore`); the worktree code in `subject.ts` is deleted. For a directory: recursive copy with links kept as links.
- Always excluded: `.git`, `node_modules`, the resolved cases directory when it is inside the subject, the output directory when inside, every glob in config `subjectExclude: string[]`.
- Per run: `fs.cpSync` of the export into a fresh `kit-*` temp dir, so one run's edits never reach the next. `Subject.dir` is the per-run copy when adapters see it; `SubjectSummary.dir` stays the user's path for the report.
- Produces on `RunRecord`: `subjectMutated: boolean`, `subjectChanges: ChangedFiles | null`.
- Produces: check `subject_unchanged` (no fields): score 1 when `outcome.subject.mutated` is empty; reason lists up to 10 changed paths.
- The source directory itself is hashed before the first run and after the last; a difference is a hard error at the end of the command: `the subject directory changed during the run: <paths>` (exit 3).

- [ ] **Step 1: Tests**
  - `glob.test.ts`: table of `[glob, path, expected]` including `src/**/*.ts` vs `src/a/b.ts` (true), `src/*.ts` vs `src/a/b.ts` (false), `{a,b}/x` vs `b/x` (true), `routing-*` vs `routing-1` (true), `*` vs `a/b` (false).
  - `a run cannot read cases committed inside the subject`: subject dir contains `evals/cases/restate/case.json`; config `cases` points there; script `exec` `find . -name case.json` with cwd switched to the plugin dir it was given; output is empty.
  - `an edit to the loaded subject does not reach the source directory`: script writes `<plugin dir>/skills/x/SKILL.md`; after the command, the source file is byte-identical; record has `subjectMutated: true` and `subjectChanges.modified` holds the path.
  - `subject_unchanged scores 0 for that run and 1 for a clean one`.
  - `a git-ref subject leaves out export-ignore paths`: `.gitattributes` with `secret/ export-ignore`.
  - `a link in the subject that points outside it is a load error` (Review Focus 1): `/links outside the subject/`.
  - `the second rep starts from an unedited copy`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Docs: `concepts/subjects.md`, `reference/checks.md` (generated), example `examples/cases/subject-unchanged/`. `git commit -m "feat: load every subject from a per-run copy and report edits to it"`.

### Task 5 (item 10b): Capabilities and not-applicable cases

**Files:**

- Create: `src/capabilities.ts`; Test: `src/capabilities.test.ts`
- Modify: `src/harnesses/shared.ts`, each adapter, `src/cases.ts`, `src/evaluate.ts`, `src/score.ts`, `src/report.ts`

**Interfaces:**

- Produces: `CAPABILITIES: Record<string, string>` (name → one-sentence meaning; names in Shared Vocabulary).
- Produces: `Harness.capabilities`, `Harness.status`. Initial sets, from what the code and fixtures show today: claude-code `{subagents, childCalls, loadedReport, skillListing}`; opencode `{subagents}`; codex `{subagents}`; cursor `{subagents}`; pi `{isolated}`. Later tasks add to them only with a parser test that proves the capability on a stream.
- Produces: case keys `requires: string[]` (each must be a `CAPABILITIES` name), `harnesses: string[]` with a required sibling `note: string` (load error without it).
- Produces: `applicability(harness: Harness, caseDef: Case): { applicable: true } | { applicable: false; missing: Capability[]; reason: string }` — `requires` ∪ `spec.needs(check)` for every check, minus `harness.capabilities`; or the `harnesses` list excluding this harness (reason is the `note`).
- Produces: `Results.notApplicable: { harness: string; caseId: string; missing: string[]; reason: string }[]`.
- `scoreSuites` takes the applicable case ids per harness; `SuiteScore` gains `applicable: number`, `total: number`, and `Results.commonSet: { cases: string[]; suite: Record<harness, Record<label, number | null>> } | null`.
- If no case is applicable for a harness: exit 2, `no case applies to <harness>`.

- [ ] **Step 1: Tests**
  - `a case that requires a missing capability has no run and no score`: `requires: ["mcp"]`; `records` is empty for it, `notApplicable[0].missing` equals `["mcp"]`, the suite score equals the other case's score, stdout has a `Not applicable` section naming it.
  - `an unknown capability name is a load error`.
  - `harnesses without note is a load error`.
  - `the suite line shows the applicable count`: `/Suite score: 1\.00 \(1 of 2 cases\)/`.
  - `two harnesses with different applicable sets get a common-set score`: run with `--harness claude-code,pi` using a second fake launcher behind `SKILL_EVALS_BIN_PI` (add a pi-shaped mode to the fake: enough to finish a run).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Docs: new page `concepts/capabilities.md` with the matrix generated from the adapters (add to `src/docs/reference.ts`). `git commit -m "feat: adapters declare capabilities; unmet requirements make a case not applicable"`.

### Task 6 (item 5c): `--isolated` and the loaded record

**Files:**

- Modify: `src/harnesses/shared.ts`, each adapter, `src/session.ts`, `src/run.ts`, `src/probe.ts`, `src/usage.ts`
- Test: `src/isolated.test.ts`, `src/adapters.test.ts`

**Interfaces:**

- Produces: `RunInput.isolated: boolean`; flag `--isolated`, config `isolated: boolean`.
- Each adapter with `isolated` in its capabilities turns off user-, organization- and project-level plugins, skills, rules, hooks, MCP servers and memory in `invocation`. The implementer finds the supported switches from the installed CLI's `--help` and settings reference and records them in `agents/harnesses.md`; an adapter that cannot do it does not declare the capability, and `--isolated` with that harness is a usage error naming it.
- Produces: `RunRecord.loaded: Loaded` (what the harness reported) and `RunRecord.unexpected: string[]`.
- Under `--isolated`, `invalidReason` returns `loaded outside the subject: <names>` when any reported plugin path is not the subject copy, or any reported skill, agent, MCP server or hook is not in the subject or in the adapter's `builtins: { skills: string[]; agents: string[] }` list. Flags alone are never trusted; the record is the proof.
- Loaded-subject validation (`REPORTED_LOADED`) runs for every adapter whose `capabilities` has `loadedReport`.

- [ ] **Step 1: Tests**
  - `--a none --isolated records zero skills`: fake `init.skills: []`; `records[0].loaded.skills` equals `[]`, run valid.
  - `an extra plugin under --isolated invalidates the run`: script `init.plugins` adds `/opt/org/plugin`; `invalid[0]` matches `/loaded outside the subject: \/opt\/org\/plugin/`.
  - `the same extra plugin without --isolated is recorded and the run counts`.
  - `--isolated with a harness that cannot isolate is a usage error`.
  - `the claude-code invocation carries its isolation switches only when isolated` (`src/invocation.test.ts`).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Docs: `guides/ci.md` recommends `--isolated`; `concepts/one-run.md`. `git commit -m "feat: --isolated loads nothing but the subject and proves it from the harness report"`.

### Task 7 (item 10c): Discovery, tags, selection, per-case settings, variants, schemas

**Files:**

- Create: `src/select.ts`, `src/docs/schema.ts`, `schema/case.schema.json`, `schema/config.schema.json`
- Modify: `src/cases.ts`, `src/evaluate.ts`, `src/usage.ts`, `src/cli.ts`, `src/report.ts`, `package.json` (`files` gains `schema`)
- Test: `src/select.test.ts`, `src/cases.test.ts`, `src/docs/reference.test.ts`

**Interfaces:**

- Discovery: a case is a directory holding `prompt.md` or `case.json`, at any depth; id is the relative path with `/`. A directory whose name starts with `_` is skipped with everything under it. Nothing under a case directory is searched. A directory name with `@` or `,` in a case id is a load error. A case with `case.json` and no prompt source (`prompt.md`, `turns`, or a variant `prompt`) is a load error.
- Case keys added: `tags: string[]` (each `/^[a-z0-9][a-z0-9-]*$/`), `description`, `targets: string[]`, `kind`, `expected`, `guard: boolean`, `reps: int`, `model`, `judgeModel`, `env: Record<string, string>` (keys must start with `CASE_`), `minDelta: number`, `variants: Variant[]`.
- Produces: `Variant = { id: string; promptAppend?: string; prompt?: string; heldout?: boolean; tags?: string[] }`; exactly one of `promptAppend`, `prompt`. A variant runs as its own case with id `<id>@<variant>`, sharing everything else. A case with variants does not also run bare.
- Produces: `selectCases(cases: Case[], by: Selection): Case[]`, `Selection = { ids?: string[]; notIds?: string[]; tagsAny?: string[]; tagsAll?: string[]; notTags?: string[]; heldout?: boolean }`. Flags: `--case` (repeatable; comma lists; globs from `src/glob.ts`), `--not-case`, `--tag`, `--tag-all`, `--not-tag`.
- `readOptions` in `cli.ts` gains `multiple: true` for repeatable flags and `type: "boolean"` for switches (`FlagSpec.kind: "text" | "list" | "switch"`).
- Report: guard cases in their own table; a "Coverage by target skill" table (`skill | cases | dev | held-out | guards`), also `list --targets`.
- Schemas: `caseSchema(): object`, `configSchema(): object` built from `CASE_KEYS`, `FIELDS`, `CHECKS`, `CONFIG_KEYS`; `reference.test.ts` fails when the committed files differ.

- [ ] **Step 1: Tests**
  - `cases load from nested directories with path ids`: `cases/routing/bug/first` → id `routing/bug/first`.
  - `a directory that starts with an underscore is never a case`, `a directory inside a case is not a case` (Review Focus 5), `an @ in a directory name is a load error`.
  - `--tag smoke,core selects either; --tag-all smoke,routing needs both; --not-tag slow removes`.
  - `--case "routing/**" --case "pressure/{a,b}" --not-case "**/slow-*"`.
  - `a 400-case tree selected by two tags`: generate 400 dirs in a loop; `list --tag core --tag-all routing` prints the expected count and the coverage table has a row per `targets` name.
  - `per-case reps overrides --reps`: `reps: 1` with `--reps 3` → one record per subject.
  - `a variant is addressable as id@variant and appends to the prompt`: the fake's `Seen.prompt` ends with the appended text.
  - `the committed schemas match the code` and `every example case validates against case.schema.json` (a 60-line validator for the schema subset used lives in the test file, not in `src/`).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Docs: `guides/organise-a-suite.md` (new), commands and config reference (generated). `git commit -m "feat: nested cases, tags, multi-glob selection, per-case settings, variants, JSON Schemas"`.

### Task 8 (item 18a): `--help` and `validate`

**Files:**

- Create: `src/commands/validate.ts`; Modify: `src/cli.ts`, `src/usage.ts`; Test: `src/cli.test.ts`, `src/commands/validate.test.ts`

**Interfaces:**

- `skill-evals --help`, `skill-evals help`, `skill-evals <command> --help` print to stdout and exit 0. `commandUsage(name, commands): string` lists only that command's flags.
- Produces: `validate(options, project): number` — loads cases strictly, then reports **problems** (exit 2) and **warnings** (exit 0): regex compile, path safety, capability names, tag names, `fixtures`/`grader`/`home` existence (as later tasks add them), every `targets` and `skill` name present in the subject (`--subject`, default the project) unless the check is `skill_not_loaded`/`skill_not_available`, and for each installed harness the not-applicable cases.
- Produces: `interface Lint { level: "problem" | "warning"; caseId: string; text: string }` and `LINTS: ((cases: Case[], context: LintContext) => Lint[])[]` — later tasks append to this list (judge weight share in Task 17, blinding in Task 31).

- [ ] **Step 1: Tests**: `--help exits 0 and prints the command table on stdout`; `score --help lists --subject and not --a`; `validate exits 2 and names every bad case, not only the first`; `validate warns when targets names a skill the subject lacks`; `validate spends nothing` (the fake writes a marker file when started; assert it is absent).
- [ ] **Step 2:** Implement. `loadCases` gains an internal collecting mode so `validate` reports all errors.
- [ ] **Step 3:** `git commit -m "feat: --help for every command, and a validate command"`.

---

## M2: free checks for routing and behaviour (items 3, 8, 9)

### Task 9 (item 3): Matchers, counts, order, first action

**Files:**

- Create: `src/matchers.ts`; Modify: `src/checks/tools.ts`, `src/checks/skills.ts`, `src/checks/fields.ts`, `src/harnesses/claude-code.ts`, `src/harnesses/shared.ts`
- Test: `src/matchers.test.ts`, `src/tools.test.ts`, `src/adapters.test.ts`

**Interfaces:**

- Produces: `ToolMatcher = { kind?: ToolKind; name?: string; inputMatches?: string; flags?: string; inputLinesMax?: number; by?: By }` (`by` and `inputLinesMax` are parsed here and rejected with "not yet supported" until Tasks 16 and 10).
- Produces: `parseMatcher(raw: unknown, where: string): ToolMatcher` (strict keys; at least one of `kind`, `name`, `inputMatches`, `by`), `matches(matcher: ToolMatcher, call: ToolCall): boolean`, `quoteCalls(calls: ToolCall[], around: number[], limit = 12): string` — one line per call: `#<index> t<turn> <agent.type> <kind> <name> <first 80 chars of input JSON>`.
- `tool_called`: optional `min` (default 1), `max` (default none), `sameTurn: boolean`, `first: boolean` (Task 16 uses it with `by`). `tool_not_called` is `tool_called` with `max: 0`, `min: 0`. `min > max` is a load error.
- `tool_order`: exactly one of `{ before, after }` (each a matcher plus `which: "first" | "last"`, default `first`) or `{ sequence: ToolMatcher[], strict?: boolean }`. Pair form: 1 when both match and the chosen `before` index is lower than the chosen `after` index; a side with no match scores 0 and the reason says which. Sequence form: the matchers match in order as a subsequence; with `strict: true`, no call matching a later matcher appears before an earlier one's first match, and no call matching an earlier matcher appears after a later one's first match (this is how "no researcher after the synthesizer" is written).
- `first_tool`: `{ matches: ToolMatcher, ignoring?: ToolMatcher[] }`.
- `skill_loaded`: `skill` or `anyOf: string[]` (exactly one), `first: boolean`, `ignoring?: ToolMatcher[]`. `first`: the first skill-load is one of the named skills and no call outside `ignoring` precedes it.
- `ToolCall.index` and `ToolCall.turn` set by `toolCall()`/adapters. Claude Code: `turn` increments on each new `message.id`; the adapter gains `turnGrouping` only after the new capture (below) proves ids are distinct. `spec.needs` for `sameTurn` → `["turnGrouping"]`.
- Every rule in `tools.ts` and `skills.ts` returns a `reason` on failure built with `quoteCalls`.

- [ ] **Step 1: Tests** (`src/tools.test.ts`, one scripted run each, asserting `records[0].checks[i].score` and `reason`):
  - `exactly one synthesizer`: two matching calls, `min: 1, max: 1` → 0, reason matches `/2 matching calls.*max 1/`.
  - `a failing check run precedes the first source edit`: order `Bash(npm test)`, `Edit(src/a.ts)`, `Bash(npm test)` → `before/after` 1; second check `{ before: { kind: "edit", which: "last" }, after: { kind: "shell", inputMatches: "npm test", which: "last" } }` → 1; with the last `Bash` removed → 0.
  - `first_tool ignores an allowlisted read`: `Read(harness-adapter.md)`, `Skill(magic-mode)` → 1; `Read(src/a.ts)` first → 0.
  - `skill_loaded first`, `skill_loaded anyOf`.
  - `two researchers in one turn, then one synthesizer, none after`: `parallel` of two `Agent` calls, then one → `sameTurn` 1; `sequence … strict: true` 1; a third researcher after → 0.
  - `sameTurn on a harness without turn grouping makes the case not applicable`.
  - `a 0.0.1 tool_called with no min still means at least one`.
- [ ] **Step 2:** Capture: add `test/fixtures/claude-code-turns.stream.jsonl`, hand-built from the documented event shape with distinct `message.id` and `tool_use.id` values (a real capture replaces it in Task 29). Parser test: two `tool_use` blocks with one `message.id` share a `turn`.
- [ ] **Step 3:** Implement; docs + examples `examples/cases/tool-order/`, `first-tool/`. `git commit -m "feat: count, order and first-action checks on tool calls"`.

### Task 10 (item 8): File-state checks

**Files:**

- Modify: `src/checks/files.ts`, `src/session.ts` (seed snapshot before the harness starts), `src/run.ts`, `src/matchers.ts`
- Test: `src/files.test.ts`

**Interfaces:**

- `session()` takes the seed snapshot after the workspace copy (and, from Task 13, after setup) and passes `seed: Snapshot` and `home` to `use`. `RunRecord.changedFiles: ChangedFiles`.
- New checks, all fields as in the brief: `file_absent`, `file_lacks`, `file_unchanged`, `file_changed`, `files_changed_only` (`allow: string[]`, optional `ignore: string[]`), `file_count` (`min` default 1, `max`), `dir_exists`, `file_lines` (`min`, `max`, at least one).
- `path` is a glob everywhere. `file_matches`/`file_lacks` take `quantifier: "any" | "all"` (defaults `any` / `all`). A glob that matches no file: `file_matches`, `file_changed`, `file_exists` score 0; `file_lacks`, `file_absent` score 1; `file_unchanged` scores 0 when the seed had matches that are now gone and 1 when neither seed nor workspace has any.
- `file_exists` gains `created: boolean`.
- `root: "workspace" | "home"` (default `workspace`) on every file check.
- `inputLinesMax` on a matcher: the call's input, taking the longest string value in it, has at most that many lines.
- Files are read as UTF-8 with replacement, capped at 5 MB per file for pattern checks; a larger file scores 0 with `file is larger than the 5 MB pattern cap`.

- [ ] **Step 1: Tests**: one scripted run that creates `docs/research/a.md`, edits `src/parse.py`, deletes `src/legacy/formatPrice.ts`, leaves `tests/` alone; assert each new check type both ways (a passing and a failing form) in a table-driven test. Plus:
  - `changedFiles lists created, modified and deleted`.
  - `root home reads the throwaway home`.
  - `a glob never follows a link out of the workspace` (Review Focus 1): script creates `ln -s /etc etc`; `file_exists path "etc/passwd"` scores 0.
  - `the agent deleting the whole workspace still yields a record` (Review Focus 2): every file check scores 0 or 1 by its absent-file rule, none throws.
  - `ten thousand matches hit the cap with the glob named` (Review Focus 4).
  - `a 0.0.1 file_exists or file_matches with a plain path scores as before`. A path that contains `*`, `?` or `{` is now read as a glob; that is a listed change in the migration note (Task 33).
- [ ] **Step 2:** Implement; docs; one example per check under `examples/cases/`. `git commit -m "feat: file-state checks against a seed snapshot"`.

### Task 11 (item 9a): Trustworthy skill-load detection

**Files:**

- Create: `src/skill-events.ts`; Modify: `src/run.ts`, `src/checks/skills.ts`, adapters
- Test: `src/skills.test.ts`

**Interfaces:**

- Produces: `SkillEvent = { skill: string; via: "skill_tool" | "file_read" | "injected"; index: number; resolved: boolean; type: "load" | "file_read"; file?: string }`.
- Produces: `skillEvents(calls: ToolCall[], subject: { dir: string | null; skillDirs: Record<string, string> }, paths: { home: string; workspace: string }): SkillEvent[]`.
- Rules: `skill_tool` — a `skill`-kind call naming a skill (plugin prefix stripped); `resolved` is true when the name is in the subject's skills (and, from Task 14, the tool result is not an error). `file_read` — a **read-kind** call whose path argument resolves (against the workspace, following the adapter's known skill locations in the throwaway home and the subject copy) to `<a subject skill dir>/SKILL.md`. A shell command or search that mentions the path is not a load. A read of any other file under a subject skill dir is `type: "file_read"` with `file` relative to the skill dir.
- `skillsLoaded` on the record stays, as the sorted names of `type: "load"` events. **Compatibility:** a 0.0.1 `skill_loaded` with no new field keeps the old rule (any input mentioning `skills/<x>/skill.md`) when `--lenient` is set, and uses the new rule otherwise; the migration note calls this out as the one scoring change, and the changelog marks it as a fix.
- `skill_loaded` gains `via: "skill_tool" | "file_read" | "any"` (default `any`), `resolved: boolean`. New checks `skill_available`, `skill_not_available` (`skill`; needs `skillListing`; reads `outcome.loaded.skills`), `skill_file_read` (`skill`, `path` glob).
- Produces `Harness.pathOf(call: ToolCall): string | null` — the file a read-kind call targets, so path extraction stays in the adapter.

- [ ] **Step 1: Tests**
  - `a fixture path that looks like a skill file is not a load`: `Read(workspace/skills/foo/SKILL.md)` with subject skill `foo` elsewhere → `skill_loaded foo` scores 0.
  - `a grep across skills is not a load`: `Bash(grep -r x skills/foo/SKILL.md)` → 0.
  - `reading the subject copy's SKILL.md is a load via file_read`.
  - `the none arm calling the skill tool with a name is unresolved`: `skill_loaded { resolved: true }` → 0, plain `skill_loaded` → 1 with `via: "skill_tool"`.
  - `skill_available reads the listing; not applicable on a harness without one`.
  - `skill_file_read sees references/bug-fix.md`.
- [ ] **Step 2:** Implement; docs. **Target case 1** now loads and grades: add `test/target/cases/routing-first-action/` and scripts `routing-first-action.match.json`, `.wrong-skill.json`, `.edit-before-skill.json`; `src/target-cases.test.ts` asserts score 1 for the first and names the failing check for the others. `git commit -m "feat: skill loads are events with a mechanism; fixture paths no longer count"`.

---

## M3: outcomes (items 1, 2)

### Task 12 (item 1): The `command` check and `grader/`

**Files:**

- Create: `src/command.ts`, `src/checks/command.ts`; Modify: `src/cases.ts`, `src/session.ts`, `src/run.ts`
- Test: `src/command.test.ts`

**Interfaces:**

- Produces: `runCommand(command: string, context: CommandContext, timeoutSeconds: number): Promise<{ exit: number | null; stdout: string; stderr: string; durationMs: number; failure: "timeout" | "spawn" | null }>` — `/bin/sh -c`, cwd the workspace, own process group (reuse `exec.ts`; add stderr to its result).
- Produces: `CommandContext = { workspace: string; graderDir: string | null; seedDir: string; home: string; transcriptFile: string | null; remoteDir: string | null }`.
- Environment (exact): `PATH`, `HOME` (the throwaway home), `TMPDIR`, `LANG`, `SKILL_EVALS_WORKSPACE`, `SKILL_EVALS_GRADER_DIR`, `SKILL_EVALS_SEED_DIR`, `SKILL_EVALS_HOME`, `SKILL_EVALS_TRANSCRIPT` (set from Task 14), `SKILL_EVALS_REMOTE_DIR` (set from Task 13), plus `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME=fixture`, the two matching `_EMAIL=fixture@example.invalid`. No provider variable.
- Check `command`: `run` (text), optional `expectExit` (int, default 0), `stdoutMatches`, `stdoutLacks`, `flags`, `timeoutSeconds` (default 120), `score: "exit" | "stdout"` (default `exit`). `score: "stdout"`: the last non-empty stdout line parsed as a number in 0..1, else score 0 with reason; `expectExit` still must hold.
- `Case.graderDir: string | null` (`<case>/grader`). It is never copied before the agent runs. After the agent exits it is copied to a fresh temp dir **outside** the workspace and exposed only through `SKILL_EVALS_GRADER_DIR`. A `grader/` inside `workspace/` or a fixture is a load error.
- The seed copy: when a case has a `command` check, the workspace as it was before the agent ran is kept as a directory (`fs.cpSync` at seed time) for `SKILL_EVALS_SEED_DIR`; otherwise only hashes are kept.
- `CheckResult.command?: { run: string; exit: number | null; durationMs: number; stdout: string; stderr: string }` with each stream cut to its last 2,000 bytes; `reason` is `exit <n> in <ms> ms` plus the cut stderr on failure.
- `Rule` may return a promise; `scoreChecks` awaits rules in case order (commands may depend on each other's side effects).

- [ ] **Step 1: Tests**
  - `a held-out grader that the workspace never held passes after the agent's fix`: grader `held-out.mjs` exits 0 only when `src/parse.mjs` exports a fixed function; script writes the fix → 1; script without the fix → 0; `find "$SKILL_EVALS_WORKSPACE" -name held-out.mjs` inside an agent `exec` step prints nothing.
  - `stdoutMatches and expectExit`, `a git query that prints nothing` (`git status --porcelain` with `stdoutLacks: "."` after a `git init` in the script).
  - `score stdout reads a ratio`: grader prints `0.75` → score 0.75.
  - `a command that times out scores 0 and the run stays valid`: `sleep 5` with `timeoutSeconds: 1`; `records[0].score` is a number, `invalid` is empty, reason matches `/timed out after 1 s/`.
  - `a command that cannot start scores 0`: `run: "/nonexistent/x"`.
  - `the command environment holds no provider key`: grader prints `env`; stdout lacks `ANTHROPIC_API_KEY` set in the sandbox.
  - `a background process the agent left does not block the grader` (Review Focus 2): script `exec` `sleep 300 &`; the run finishes inside the test timeout.
  - `a mutation grader`: grader re-applies a bad change from `$SKILL_EVALS_GRADER_DIR/bad.patch` and expects the workspace's lint script to exit non-zero.
- [ ] **Step 2:** Implement; safety page section "Code that runs on your machine" (commands run as you, unsandboxed). Example `examples/cases/command/` with a `grader/`. `git commit -m "feat: command checks with a held-out grader directory"`.

### Task 13 (item 2): Setup, git fixtures, home seeding, shared fixtures

**Files:**

- Create: `src/workspace.ts`; Modify: `src/cases.ts`, `src/session.ts`, `src/run.ts`
- Test: `src/workspace.test.ts`

**Interfaces:**

- Case keys: `setup: SetupStep[]`, `home: string` (a directory in the case), `fixtures: string[]` (paths relative to the case dir; each must resolve inside the cases root and exist).
- `SetupStep = { run: string; timeoutSeconds?: number } | { git: { init?: boolean; branch?: string; commitAll?: string; remote?: string } }`. `git` expands to, in order: `git init -q -b <branch ?? "main">`, `git add -A && git commit -q -m <commitAll>`, and for `remote: "origin"`: `git init -q --bare "$SKILL_EVALS_REMOTE_DIR/origin.git" && git remote add origin … && git push -q -u origin HEAD`.
- Produces: `prepareRun(caseDef: Case, dirs: { workspace: string; home: string }): Promise<{ seed: Snapshot; seedDir: string | null; remoteDir: string; failure: string | null; dispose: () => void }>`. Order: each `fixtures` dir copied in order → `workspace/` → `<case>/fixture/` copied to `<workspace>/fixture` → setup steps (cwd the workspace, the Task 12 environment plus `SKILL_EVALS_REMOTE_DIR`, default 60 s each) → `<workspace>/fixture` removed → `home` copied into the throwaway home (after auth files, never over them) → seed snapshot. Git identity and config come from the environment, so setup never reads the operator's git config.
- A failed step: the harness never starts; record `error: "setup failed: step <n> (<first 40 chars>): <failure>"`; the run is invalid.
- `remoteDir` is a per-run temp dir outside the workspace, alive until the run's checks finish.
- Links: copied as links; a link whose target resolves outside its own source tree is a load error (Review Focus 1).

- [ ] **Step 1: Tests**
  - `a case starts on a feature branch with seven commits and an origin remote`: `fixture/build-history.sh`; the agent `exec` step `git log --oneline | wc -l` prints 7 and `git remote get-url origin` prints a path under the remote dir; `ls fixture` fails.
  - `four linked worktrees`: setup `git worktree add ../wt-N` is rejected (outside the workspace); the documented form puts them under `$SKILL_EVALS_REMOTE_DIR`; assert `git worktree list | wc -l` is 5.
  - `home seeds a user-level file and root home can assert on it`.
  - `twenty cases share one fixture directory`: loop-generate; each sees `shop-core/package.json`; `_shared` is not listed as a case.
  - `a later layer wins`: fixture and `workspace/` both hold `a.txt`.
  - `a failed setup step invalidates the run and the harness never starts` (marker file absent; `invalid[0]` matches `/setup failed: step 2/`).
  - `setup does not read the operator's git config`: sandbox `HOME/.gitconfig` sets `commit.gpgsign=true`; setup commit succeeds.
- [ ] **Step 2:** Implement. **Target case 5** (`history-clean-up`): a grader compares `git rev-parse HEAD^{tree}` in the workspace with the same query in `$SKILL_EVALS_SEED_DIR`, counts the commits and greps their subjects; the force push is a `tool_not_called` check with `inputMatches: "push.*--force(?!-with-lease)"`. `git commit -m "feat: setup steps, git fixtures, home seeding and shared fixtures"`.

---

## M4: process claims and honest judging (items 4, 7, 13)

### Task 14 (item 4a): The transcript

**Files:**

- Create: `src/transcript.ts`; Modify: every adapter, `src/harnesses/shared.ts`, `src/run.ts`, `src/session.ts`
- Test: `src/transcript.test.ts`, `src/adapters.test.ts`

**Interfaces:**

- `Harness.parse(stdout: string): Parsed` now fills `Parsed.transcript`. `Parsed.toolCalls` is always `callsOf(transcript)` — adapters stop building it themselves. Produces `callsOf(events: TranscriptEvent[]): ToolCall[]`, `event(partial): TranscriptEvent` (assigns `index`, computes `bytes`).
- Decoding: stdout is read as bytes and decoded with replacement, so invalid UTF-8 never throws (`exec.ts` returns a `Buffer`-safe string; Review Focus 4).
- Per adapter, what is filled and which capability that earns (each proved by a parser test on a fixture stream):
  - claude-code: assistant `text` blocks → `text` (`assistantText`); `tool_use` → `tool_call`; `user` events' `tool_result` blocks → `tool_result` matched by `tool_use_id` (`toolOutputs`); `message.id` → `turn` (`turnGrouping`).
  - pi: `tool_execution_start` → call; `tool_execution_end` → result if the event carries one; `turn_end` content → text; `turn` = count of `turn_end` so far.
  - opencode: `text` parts; `tool_use.part.state.output`; `step_start` → turn.
  - codex: `agent_message` items; `command_execution.aggregated_output`; no turn grouping within a turn (do not declare `turnGrouping`).
  - cursor: `assistant` events; `tool_call` `completed` subtype result; declare nothing until Task 29.
  - An adapter declares a capability only when its fixture test passes; otherwise the matrix says no.
- Produces: `writeTranscript(stem: string, events: TranscriptEvent[]): string` → `<stem>.transcript.json` (full, pretty JSON); `RunRecord.transcriptFile` (relative to the out dir). `SKILL_EVALS_TRANSCRIPT` is now set for command checks.
- Produces: `forRecord(events, capBytes = 20_000): TranscriptEvent[]` (cuts `text`/`output`, sets `truncated`, keeps `bytes`).

- [ ] **Step 1: Tests**: per adapter, `parse` of a fixture yields the expected `[role, type, kind]` sequence and outputs; `toolCalls equals callsOf(transcript)` for all five; `a binary tool output is decoded and its byte size recorded`; `a 50 MB output is whole on disk and cut in forRecord` (generate in the test; skip the 50 MB figure down to 2 MB with the cap lowered through the function argument); `the transcript file is written beside the stream file`.
- [ ] **Step 2:** Implement. Extend fixtures by hand from each harness's documented event shapes; mark each fixture's provenance in a `test/fixtures/README.md` table (`captured` / `from documentation`).
- [ ] **Step 3:** Docs: `concepts/transcript.md` with the per-harness table generated from capabilities. `git commit -m "feat: every adapter emits one normalized transcript"`.

### Task 15 (item 4b): Transcript checks

**Files:** Create `src/checks/transcript.ts`; Modify `src/transcript.ts`; Test `src/transcript-checks.test.ts`

**Interfaces:**

- Produces: `slice(events, scope: Scope, where: Where): string[]` — the texts to test. `Where = "assistant_text" | "tool_input" | "tool_output" | "all"`. `Scope = "first_message" | "final_message" | "any" | { before: ToolMatcher } | { after: ToolMatcher }`. `first_message` is every main-agent assistant text event before the first main-agent tool call or the end of the first turn, whichever the harness can show: with `turnGrouping`, the first turn's text; without it, text events before the first tool call. `before`/`after` cut at the **first** match; no match → empty slice, and the check scores 0 with that reason.
- Checks: `transcript_matches`, `transcript_lacks` (`pattern`, `flags`, `where` default `assistant_text`, `scope` default `any`); `tool_output_matches` (`tool: ToolMatcher`, `pattern`, `which: "first" | "last" | "any"` default `any`); `tool_output_lacks` (same); `tool_output_size` (`maxBytes`, optional `tool`).
- `needs`: `assistant_text` → `assistantText`; any `tool_output*` or `where: "tool_output" | "all"` → `toolOutputs`.
- Patterns run on text capped at 1 MB per event; the cap is in the docs.

- [ ] **Step 1: Tests**: `the first assistant message restates the goal` (both ways); `red before green`: `Bash(npm test)` `exec` against a workspace whose test fails, then an edit, then a passing run → `{which: "first", pattern: "\\bfail"}` 1 and `{which: "last", pattern: "\\bpass"}` 1; with the agent only _claiming_ success in text and running `true` → 0; `tool_output_size`; `scope before/after`; `not applicable where tool outputs are missing`.
- [ ] **Step 2:** Implement. **Target case 2** (`red-before-green`): `tool_output_matches` ×2, `tool_order` ×2, `file_unchanged tests/**`, `command` held-out grader. `git commit -m "feat: checks on assistant text and tool outputs"`.

### Task 16 (item 7): Subagent attribution

**Files:** Modify adapters, `src/matchers.ts`, `src/checks/tools.ts`, `src/checks/transcript.ts`, `src/skill-events.ts`; Test `src/attribution.test.ts`

**Interfaces:**

- Every `TranscriptEvent.agent` is set. Main thread: `{ id: "main", type: "main", parent: null, depth: 0 }`. Claude Code: an event with `parent_tool_use_id` belongs to the agent whose `id` is that tool-use id; `type` is `normalizeAgent(input.subagent_type)`; `parent` is the dispatching agent's id; depth follows the chain. Produces `normalizeAgent(name: string): string` — the part after the last `:` (same rule as skills).
- Capabilities: `childCalls` (child tool calls visible), `childText`, `subagents` (dispatch visible). Other adapters: only the dispatch call is visible today → `subagents` only.
- `By = "main" | "subagent" | { agent: string }` on every matcher and on `transcript_*`. `needs`: `by: "main"` or any agent form → `childCalls` (without it, "main made no edit" cannot be told from "nobody did"); `transcript_*` with `by` agent → `childText`.
- `tool_called { first: true, by }`: the first call **by that agent** matches.
- Check `agent_dispatched`: `agent` (text), `min` (default 1), `max`, `briefMatches`, `flags`. Matches a `subagent`-kind call whose normalized type equals `agent`; **fallback**: when the dispatch names a generic type (`general-purpose`, or none), it matches if the brief's first 400 characters contain the agent name as a whole word or a front-matter line `name: <agent>`. The record marks which rule matched (`reason: "matched by inlined definition"`); the docs state the fallback.
- `skill_loaded` gains `by`.

- [ ] **Step 1: Tests**: `a read-only agent that edits fails tool_not_called by agent`; `the main thread made no source edits and the delegate did`; `the delegate read the workflow skill first` (`tool_called read first by agent`); `the planner made zero tool calls`; `agent_dispatched counts by normalized name` (`magic:researcher-mid:researcher-mid` → `researcher-mid`); `agent_dispatched falls back to an inlined definition`; `a by check on a harness without child calls is not applicable`; `nesting sets depth 2`.
- [ ] **Step 2:** Implement. **Target cases 3, 4, 11**: `research-pipeline-shape` (adds `file_count docs/research/*.md`, `file_exists created`, a `git status` grader), `read-only-under-temptation` (`tool_not_called by agent` for write and edit, `file_unchanged README.md`, `output_matches` headings), `kit-editing-in-isolation` (`tool_order` baseline subagent before first write of the skill file, a frontmatter grader, `subject_unchanged`). `git commit -m "feat: attribute every event to its agent; scope checks with by"`.

### Task 17 (item 13): Judge and decision

**Files:** Create `src/judge-api.ts`, `src/cache.ts`; Modify `src/judge.ts`, `src/decision.ts`, `src/run.ts`, `src/checks/index.ts`, `src/commands/validate.ts`; Test `src/judge.test.ts`, `src/judge-api.test.ts`, `src/testing/judge-server.ts`

**Interfaces:**

- `judge` and `decision` gain `sees: ("final" | "transcript" | "files")[]` (default `["final"]`), `files: string[]` (globs; required with `"files"`), `maxChars: int` (default 60,000 for the transcript rendering, 20,000 per file).
- Produces: `renderTranscript(events, maxChars): string` — one line per event `[#i t<turn> <agent.type>] <role> <type>: …`; inputs as compact JSON, outputs cut to 400 chars each first, then oldest tool outputs dropped until it fits; the cut is stated in the text (`[… 12 tool outputs omitted …]`). Image files named in `files` are passed as attachments on the API path only; on the harness path they are listed by name with "not shown".
- `judge` gains `scale: "binary" | "0-1"` (default `0-1`, so 0.0.1 rubrics score the same; docs recommend `binary`), `votes: int` (odd, default 1), `rubric` as text **or** `{ pass: string; fail: string }`. Binary reply shape: `{"reason": "...", "verdict": "pass" | "fail"}`. With votes: binary → majority; `0-1` → median. `CheckResult.votes: { score: number; reason: string }[]`.
- Produces: `askApi(config: JudgeApi, prompt: string, attachments: Attachment[]): Promise<{ text: string; usage: Usage }>`, `JudgeApi = { kind: "anthropic" | "openai"; url: string; model: string; keyVar: string }`. Config keys `judgeApi`, `judgeUrl`, `judgeKeyVar`; flags `--judge-api`, `--judge-url`. `anthropic` posts the Messages API shape, `openai` the chat-completions shape; both tested against `src/testing/judge-server.ts`. The key variable is added to `withhold`.
- Default judge model: `judgeModel` if set, else `model`; when the two are equal (or both unset), one stderr warning per command: `the judge is the model under test`.
- Produces: `cacheKey(rubric, content, model): string` (sha256), `Cache = { get(key), set(key, value) }` stored in `<out>/judge-cache.jsonl`.
- Lint (appended to `LINTS`): warn when judged plus decision checks carry more than `maxJudgedWeightShare` (config, default 0.5) of a case's weight.
- `decision`: marked **experimental** in `reference/checks.md` and the guide, with the reason (hosted endpoint never called). No code change.

- [ ] **Step 1: Tests**: `sees transcript puts tool calls in the judge prompt` (read `prompts.jsonl`); `sees files includes the named file and not others`; `a rendering over maxChars says what it left out`; `three votes, two pass, scores 1 and records all three`; `structured rubric becomes pass/fail sections`; `the api path sends no harness process` (marker absent) and `sends the key header`; `a cached verdict is reused on a second identical question`; `the same-model warning prints once`; `validate warns at 60% judged weight`; `a 0.0.1 judge check sends the same prompt as before` (snapshot of today's prompt).
- [ ] **Step 2:** Implement; docs `guides/judged-checks.md`. `git commit -m "feat: the judge can see the transcript and files, vote, and run without a harness"`.

---

## M5: scale and gates (items 11, 12, 18b)

### Task 18 (item 11a): Streaming exec, turn limits, `stoppedBy`

**Files:** Modify `src/exec.ts`, `src/session.ts`, `src/harnesses/shared.ts`, adapters, `src/run.ts`; Test `src/limits.test.ts`

**Interfaces:**

- `exec(bin, args, options & { onStdout?: (chunk: string) => "continue" | "stop" })`: `"stop"` kills the process group and resolves with `failure: null`, `stopped: true`.
- `Harness.countTurns?(lineJson: unknown, state: { turns: number }): void` — optional; present for adapters with `turnGrouping`. The runner stops when `state.turns > maxTurns`.
- `RunRecord.stoppedBy: "agent" | "maxTurns" | "timeout"`, `RunRecord.maxTurnsEnforced: boolean`, `RunRecord.turns: number | null`.
- `maxTurns` hit → valid, scored, final text is the last assistant text seen. Timeout → invalid as today, with `firstOutputMs: number | null` recorded for Task 19's retry rule.

- [ ] **Step 1: Tests**: `a run stopped at maxTurns is scored and says so`; `a harness without turn counting records maxTurnsEnforced false and a report note`; `a timeout stays invalid with stoppedBy timeout`; `the process group is gone after a stop` (`slow-harness.mjs` child pid check).
- [ ] **Step 2:** Implement. `git commit -m "feat: enforce turn limits in the runner on every harness"`.

### Task 19 (item 11b): Jobs, incremental results, resume, budget, retries, plan

**Files:** Create `src/schedule.ts`, `src/store.ts`, `src/commands/plan.ts`; Modify `src/evaluate.ts`, `src/cli.ts`, `src/usage.ts`; Test `src/schedule.test.ts`, `src/store.test.ts`, `src/resume.test.ts`

**Interfaces:**

- Produces: `pool<T>(jobs: (() => Promise<T>)[], limit: number, gate: () => "go" | "stop"): Promise<(T | undefined)[]>` — results in input order; after `"stop"`, no new job starts and in-flight ones finish.
- Produces: `runKey(plan: RunPlan): string` = sha256 of `{ caseHash, subjectRevision, harness, model, rep, toolVersion }`; `caseHash(caseDef)` hashes the case directory, its fixtures and its grader; `subjectRevision` is the export's tree hash.
- Produces: `Store = { append(record: RunRecord & { key: string; attempt: number }): void; flush(results: Results): void; load(outDir): Map<string, RunRecord> }`. `append` writes one `JSON.stringify` line with a single `fs.appendFileSync` call from the main process (jobs are async, not threads, so appends never interleave). `flush` writes `results.json.tmp` then renames. `load` drops a last line that is not valid JSON and warns (Review Focus 3).
- `Results.partial: { reason: "budget" | "duration" | "interrupted" } | null`. On SIGINT: flush with `partial`, exit 130 (extend `onDispose`).
- Flags: `--jobs <n>` (default 1), `--resume <dir>` (reuses valid records with the same key; implies `--out <dir>`), `--max-cost <usd>`, `--max-duration <min>`, `--retries <n>` (default 0), `--dry-run`; command `plan`.
- Budget: checked before each launch against summed `costUsd` (agent + judge + decision) and elapsed wall time. A harness that reports no cost makes `--max-cost` a usage error for it. After a breach, judged and decision checks on in-flight runs are skipped with `reason: "skipped: budget reached"`, which leaves those runs invalid and marked `skippedGraders: true` so `rejudge` can finish them. Exit 4.
- Retries: only when the invalid reason is one of `harness crash` (non-zero exit with no result event), `rate limit` (adapter `isRateLimit(error): boolean`), or `timeout before first output`. Never for a setup failure, precondition, isolation breach or a low score. `RunRecord.attempts: { error: string }[]`.
- Progress line on stderr gains `[n/N] $<spent> ETA <mm:ss>`.
- `plan`: prints the matrix (harness × case × subject × reps), the run count, the not-applicable list, and, when `--resume`/`--out` holds a prior `results.json`, estimated cost and duration from per-case medians.

- [ ] **Step 1: Tests**: `pool keeps order and never exceeds the limit` (unit, counters); `eight jobs finish a 20-case suite with records in plan order`; `each job has its own home and workspace` (distinct `Seen.home`); `results.jsonl grows by one line per run and results.json is valid after each` (inspect from `onRun`); `an interrupted run resumes without repeating finished runs` (first invocation with `--max-duration` tiny to stop early, second with `--resume`; fake start-marker count equals total runs); `a changed case file is re-run on resume`; `a truncated last line is dropped and its run repeats`; `--max-cost stops cleanly with exit 4 and partial set`; `a crash is retried once and both attempts are recorded` (fake `fail` step on first start, by a counter file); `a low score is never retried`; `plan prints the run count and spends nothing`.
- [ ] **Step 2:** Implement; docs `guides/ci.md` (rate limits are shared across jobs). `git commit -m "feat: parallel jobs, incremental results, resume, budgets and infrastructure retries"`.

### Task 20 (item 12a): Exit codes, invalid-run budget, report formats, run metadata

**Files:** Create `src/report/json.ts`, `junit.ts`, `html.ts`; move `src/report.ts` → `src/report/markdown.ts`; Modify `src/cli.ts`, `src/evaluate.ts`; Test `src/report.test.ts`, `src/exit-codes.test.ts`

**Interfaces:**

- `EXIT = { ok: 0, bar: 1, usage: 2, invalid: 3, partial: 4, interrupted: 130 }`; precedence when several apply: usage, interrupted, partial, invalid, bar.
- `--max-invalid <fraction>` (default 0): exit 3 only when invalid ÷ planned runs exceeds it. Every score in every report is printed with `(k of n runs)`.
- `--report md|json|junit|html` (repeatable; `md` to stdout, others to `<out>/report.<ext>`); `summary.json` always written: `{ schemaVersion: 1, exit, suites: [{ harness, label, score, applicable, total, validRuns, plannedRuns }], belowBar, invalid: n, notApplicable: n, partial, costUsd, durationMs }`.
- `Results.schemaVersion: 1`, `Results.meta: { toolVersion, harnessVersions: Record<id, string | null>, models, subjects: [{ label, revision, dirty: boolean }], caseHashes, isolated: boolean }`. Each harness version is read with `<bin> --version`.
- JUnit: one `testsuite` per harness × subject, one `testcase` per case; below-bar → `failure`, invalid → `error`, not applicable → `skipped`.
- HTML: one self-contained file, no script from a network, tables only.

- [ ] **Step 1: Tests**: each exit code from a minimal scenario; `--max-invalid 0.5 tolerates one of three`; `junit marks a not-applicable case skipped`; `summary.json matches the report's suite score`; `the valid-run count is beside every score`; `html has no external reference` (`/(src|href)="https?:/` absent).
- [ ] **Step 2:** Implement; `reference/exit-codes.md`. `git commit -m "feat: distinct exit codes, an invalid-run budget, and json, junit and html reports"`.

### Task 21 (item 12b): Noise floor, delta bars, discrimination

**Files:** Create `src/stats.ts`, `src/commands/calibrate.ts`; Modify `src/score.ts`, `src/report/markdown.ts`, `src/evaluate.ts`; Test `src/stats.test.ts`, `src/compare.test.ts`

**Interfaces:**

- Produces: `bootstrapDelta(a: number[], b: number[], options: { resamples: 2000; seed: number }): { delta: number; low: number; high: number }` — percentile bootstrap over runs, 95%, a seeded generator (mulberry32) so reports are reproducible. Suite deltas resample runs within each case (stratified).
- Produces: `calibrate` command: runs the subject against itself (`a` and `b` the same export) at `--reps` (default 5); writes `<out>/noise.json`: `{ schemaVersion: 1, perCase: Record<id, { sd: number; maxAbsDelta: number }>, perCheckType: Record<type, { sd: number }>, suite: { sd, p95AbsDelta } }`. Config/flag `--noise <file>`.
- Produces: `verdict(delta, interval, noise): "helped" | "hurt" | "within noise"` — within noise when the interval contains 0 or `|delta| <= noise.p95AbsDelta` (when a noise file is given). The report prints the verdict per case and for the suite, and the method in one footnote.
- `--min-delta <x>` and per-case `minDelta`: a bar on `b − a`; missed bars join `belowBar`.
- Discrimination (only when a subject is `none`): each non-guard case gets the first label that fits, in this order: `non-discriminating` (the `none` arm scores at least 0.9), `failing with the subject` (the subject arm scores below 0.5), `discriminating` (the delta's verdict is "helped"), else `no evidence`. The two thresholds are named constants and the report prints them.
- Per-check table gains a flake column: the share of reps disagreeing with the majority, per subject.

- [ ] **Step 1: Tests**: `bootstrapDelta is reproducible for a seed and brackets a known shift` (unit, fixed arrays); `A/A calibrate writes a noise file with zero spread for a deterministic fake`; `a delta inside the noise floor reads "within noise"`; `--min-delta fails a run whose delta is 0`; `guard cases are left out of the discrimination table`; `a flaky check shows its rate` (fake alternates by a counter file).
- [ ] **Step 2:** Implement; `guides/pass-bars.md`, `guides/read-the-report.md`. `git commit -m "feat: noise calibration, delta bars with intervals, and a discrimination report"`.

### Task 22 (item 12c): `diff` and `rejudge`

**Files:** Create `src/commands/diff.ts`, `src/commands/rejudge.ts`; Modify `src/session.ts`, `src/run.ts`, `src/store.ts`; Test `src/diff.test.ts`, `src/rejudge.test.ts`

**Interfaces:**

- `--keep-workspaces`: after checks, the workspace, seed dir and throwaway home (minus auth files) are stored as `<stem>.workspace.tar` using the system `tar` (a missing `tar` is a usage error for this flag). `RunRecord.workspaceArchive`.
- Produces: `rescore(record: RunRecord, caseDef: Case, context): Promise<RunRecord>` — rebuilds `Outcome` from the transcript file and the unpacked archive and re-runs every check; judge calls go through the cache.
- `rejudge <out dir>`: flags `--cases`, `--case`, `--judge-model`, `--judge-api`, `--out` (default: write `results.rejudged.json` beside the original, never over it). A record without an archive re-scores only checks that need neither workspace nor home; the rest keep their old score and are listed as "not re-scored".
- `diff <a> <b>`: per-case score change, newly failing and newly passing checks (matched by check description), cost and duration change. Different `meta.models`, harness, or a case hash → a warning block at the top; `--strict` turns it into exit 2.

- [ ] **Step 1: Tests**: `a rewritten pattern is re-scored without starting the harness` (marker count unchanged); `a rewritten rubric with a cache miss calls only the judge`; `rejudge leaves results.json untouched`; `diff lists a newly failing check`; `diff warns when the model differs and --strict exits 2`.
- [ ] **Step 2:** Implement. `git commit -m "feat: diff two result files; rejudge stored runs without the agent"`.

### Task 23 (item 18b): `init`, `explain`, `show`, packaging

**Files:** Create `src/commands/init.ts`, `explain.ts`, `show.ts`, `examples/cases/*`, `examples/graders/text-metrics.mjs`; Modify `package.json`, `src/package.test.ts`, `src/docs/examples.test.ts`; Test `src/commands/*.test.ts`

**Interfaces:**

- `init <id> --kind trigger|negative|behaviour|pressure|agent|outcome|prose`: writes `prompt.md` and `case.json` from a template table `TEMPLATES: Record<kind, { prompt: string; case: object }>`; refuses an existing directory; every template passes `validate`.
- `explain <id>`: prints the resolved case as JSON-in-Markdown: prompt(s), turns, layered fixture list in order, setup steps, checks with every default filled in, required capabilities, applicability per installed harness.
- `show <out dir> <case> [--subject <label>] [--rep <n>]`: the transcript, one line per event, then each check with score and reason.
- `package.json` `files` adds `examples`, `schema`, `docs/design`, `docs/src/content/docs`. `package.test.ts`: the tarball holds `examples/cases/hello/case.json`, `schema/case.schema.json`, `docs/src/content/docs/reference/checks.md`; `unshipped` regex updated on purpose.
- `examples.test.ts`: there is exactly one example directory per key of `CHECKS`, and each loads.
- `text-metrics.mjs`: reads a file path argument; flags `--max-sentence-words`, `--percentile`, `--banned <file>`, `--strip-code`; prints `ok` or the violations; documented in `guides/prose-checks.md`.
- Authoring loop documented in `guides/write-a-case.md`: `score --case <id> --reps 1 --keep-workspaces`, then `show`, then `rejudge`.

- [ ] **Step 1: Tests**: `every init template validates`; `explain fills defaults` (`min: 1`, `timeoutSeconds: 600`); `show prints a failing check's reason beside the calls it quotes`; `one example per check type`; packaging assertions; `text-metrics flags a 41-word sentence at --max-sentence-words 40`.
- [ ] **Step 2:** Implement. `git commit -m "feat: init, explain and show; ship examples, schemas and docs in the package"`.

---

## M6: history, rules, ablation (items 6, 14)

### Task 24 (items 6a, 9b): Turns and user invocation

**Files:** Create `src/turns.ts`; Modify `src/cases.ts`, `src/session.ts`, `src/run.ts`, adapters, `src/transcript.ts`; Test `src/turns.test.ts`

**Interfaces:**

- Case key `turns: Turn[]`; `Turn = { prompt: string (a file in the case dir) } | { invoke: { skill: string; args?: string } } | { event: "compact" | "clear" | "resume" }`, each with optional `checks: Check[]`. `prompt.md` alone is one turn. `prompt.md` and `turns` together is a load error.
- `RunInput` gains `turn: { index: number; message: string | null; invoke: Turn["invoke"] | null; event: string | null }` and `session: string | null` (the previous turn's `Parsed.sessionId`). One harness process per turn; the adapter continues the session by its own means and declares `multiTurn` only when it can. `Harness.userInvocation?(invoke): string` maps an invocation to the harness's user syntax (`userInvoke`). Lifecycle events are per-adapter (`compact`, `clear`, `resume` capabilities). The implementer confirms each CLI's continuation flag from its `--help`; anything unconfirmed stays undeclared.
- Produces: `runTurns(session, turns): Promise<{ parsed: Parsed; perTurn: Parsed[]; stoppedBy }>`. Tokens and cost are summed. `timeoutSeconds` applies per turn; the overall cap is `timeoutSeconds × turns`, overridable with `totalTimeoutSeconds`. The merged `parsed` has `userTurn` set on every event.
- Per-turn checks get an `Outcome` whose `transcript`, `toolCalls` and `finalText` are that turn's slice; workspace state is the final one (documented). `CheckResult.turn?: number`.
- `needs`: more than one turn → `multiTurn`; `invoke` → `userInvoke`; events → their capability.

- [ ] **Step 1: Tests**: `turn 2 checks see only turn 2's calls` (script: edit in turn 1; turn 2 runs a command; `tool_called edit` on turn 2 → 0, at case level → 1); `the second turn continues the first session` (fake echoes the session id it was resumed with); `cost is summed across turns`; `an invoke turn reaches the harness in its user syntax`; `a model self-invoking a user-only skill fails skill_not_loaded via skill_tool`; `a multi-turn case on a harness without multiTurn is not applicable`; `a compact event between turns` (fake records it as a `lifecycle` event).
- [ ] **Step 2:** Implement. **Target cases 6 and 8** (`pressure-across-turns`; `user-only-skill` and its negative pair). `git commit -m "feat: multi-turn cases, per-turn checks and user invocation"`.

### Task 25 (item 6b): Seeded history and session stores

**Files:** Create `src/history.ts`; Modify adapters, `src/cases.ts`, `src/turns.ts`; Test `src/history.test.ts`

**Interfaces:**

- `<case>/history.json`: `{ role: "user" | "assistant"; text: string; toolCalls?: { name: string; input: unknown; output?: string }[] }[]`; strict keys.
- `Harness.historyMode`, `Harness.installHistory?(history, input): { session: string }` for `native`; `renderPreamble(history): string` for `preamble` (a fenced, clearly delimited "Earlier in this conversation" block). `RunRecord.historyMode`. Flag `--history-mode native|preamble` (default: the adapter's).
- `<case>/sessions/`: `{ id: string; startedAt: string; cwd?: string; messages: History }[]` in `sessions.json`; `Harness.installSessions?(sessions, input): void`; capability `sessionStore`.
- History events are in the transcript with `userTurn: -1` and are excluded from every check by default.

- [ ] **Step 1: Tests**: `a twelve-message history reaches the agent before turn 1` (fake reports the count it found); `history tool calls never satisfy tool_called`; `--history-mode preamble puts the block in the prompt and records the mode`; `sessionStore plants files where the adapter says`; `a case with sessions on a harness without a store is not applicable`.
- [ ] **Step 2:** Implement. **Target case 7** (`catch-up-from-history`). `git commit -m "feat: seeded history and prior-session stores"`.

### Task 26 (item 14a): Rules, hooks, preconditions

**Files:** Modify `src/subject.ts`, adapters, `src/checks/observed.ts`, `src/cases.ts`, `src/run.ts`; Test `src/rules-hooks.test.ts`

**Interfaces:**

- Config/subject options `rules: string` (directory in the subject), `instructionFile: string`. `Harness.installRules?(files: string[], input): string[]` returns what it installed (native rules directory or an instruction-file import, per adapter); capability `rules`. `RunRecord.rules: { installed: string[]; reportedLoaded: string[] | null }`.
- `HookEvent = { event: string; command: string | null; exit: number | null; contextBytes: number | null; context: string | null }` (context cut to 4,000 chars); adapters emit `type: "hook"` transcript events where the stream has them; capability `hooks`.
- Checks: `hook_fired { event, min (default 1), max }`, `context_injected { pattern, flags }` — matches hook contexts, and, where the harness reports them, loaded rule texts.
- Case key `preconditions: Check[]` (only types whose spec has `precondition: true`: `context_injected`, `hook_fired`, `skill_available`, `skill_loaded`). Any precondition scoring 0 → run invalid: `precondition not met: <describeCheck>`. Checked before judged checks, so no judge spend on such a run.

- [ ] **Step 1: Tests**: `a hook event in the stream satisfies hook_fired`; `context_injected matches the injected bootstrap text`; `an unmet precondition invalidates the run and calls no judge`; `rules are installed and recorded`; `a rules case on a harness without rules is not applicable`; `a non-precondition check type under preconditions is a load error`.
- [ ] **Step 2:** Implement. **Target case 9** (`rule-with-precondition`): `tool_not_called shell inputMatches "sleep\\s+(3[1-9]|[4-9]\\d|\\d{3,})"`, a grader for the marker file ordering from `$SKILL_EVALS_TRANSCRIPT`. `git commit -m "feat: install rules, observe hooks, and invalidate runs whose preconditions fail"`.

### Task 27 (item 14b): Subject variants, more than two subjects, `check --json`

**Files:** Modify `src/subject.ts`, `src/isolate.ts`, `src/evaluate.ts`, `src/score.ts`, `src/report/*`, `src/probe.ts`, `src/usage.ts`; Test `src/variants.test.ts`, `src/probe.test.ts`

**Interfaces:**

- Subject spec grammar: `<spec>[:<opt>[,<opt>…]]` with `hooks=off`, `rules=off`, `skills=only:<glob>`, `skills=except:<glob>`. Applied to the export by `Harness.strip?(dir, options)` for harness-owned files plus generic skill-directory filtering. A spec that is an existing path containing `:` wins over the grammar.
- `Label` widens to `string`. `--subjects name=spec,name=spec,…` (2 to 8); `--a/--b` stay and mean labels `a`, `b`. Labels must be unique, match `/^[a-z][a-z0-9-]*$/`, and must not equal a variant id used in the suite (Review Focus 5). The first subject is the baseline; every other gets a delta, interval and verdict against it; bars apply to the last unless `--bar-subject <label>`.
- `check --json`: `{ harness, installed, status, capabilities: Record<name, boolean>, loaded: Loaded, pluginLoaded, skills: n, agents: n, rules: n, hooksFired: n, mcpServers: n }[]`; the table gains the same columns.

- [ ] **Step 1: Tests**: `hooks=off removes the hook from the copy and not from the source`; `skills=only:magic-* leaves only those`; `four subjects give one report with three deltas`; `duplicate labels are a usage error`; `a 0.0.1 two-subject results.json shape is unchanged for a and b`; `check --json parses and names every capability`.
- [ ] **Step 2:** Implement. **Target case 10** (`bootstrap-ablation`): one invocation, four variants, asserts four routing rates and a verdict column. `git commit -m "feat: subject variants and comparisons of up to eight subjects"`.

---

## M7: harness-neutral claims (items 15, 16)

### Task 28 (item 15): Mock MCP servers

**Files:** Create `src/mcp/mock-server.ts`, `src/mcp/mocks.ts`; Modify `package.json` (`bin` adds `skill-evals-mcp-mock`), adapters, `src/cases.ts`, `src/transcript.ts`; Test `src/mcp.test.ts`

**Interfaces:**

- Layout: `<case or suite>/mcp/<server>/<tool>.json`: `{ description: string; inputSchema: object; responses: { when?: Record<string, string (regex on that argument)>; text: string; isError?: boolean }[] }`; first matching response wins; no match → an error result. `text` may hold `{{argument}}` placeholders.
- The mock server speaks MCP over stdio (JSON-RPC 2.0, newline-delimited): `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`. It appends every call to `$MOCK_LOG` (`{ server, tool, input, response, at }`) in a per-run temp dir outside the workspace. The implementer checks the wire format against the current MCP specification before writing it.
- `Harness.registerMcp?(servers: { name: string; command: string; args: string[]; env: Record<string, string> }[], input): void`; capability `mcp`.
- Tool kind `mcp`; adapters map their MCP tool names to `kind: "mcp"`, `name: "<server>.<tool>"`. If a harness's stream lacks MCP calls, the runner merges the mock log into the transcript by time (events marked `source: "mock-log"`, agent unknown → `by` checks on them need `childCalls`).
- `0.0.1` compatibility: a `tool_called kind "other"` that used to match an MCP tool still matches (`other` matches `mcp` calls when the check was written without `name`; documented).

- [ ] **Step 1: Tests**: unit: the server answers `tools/list` and a templated `tools/call` over a pipe; `each server called by exactly one subagent` (three `tool_called { kind: "mcp", name: "^tracker\\.", by: … }` with counts); `no write-type call`; `an error variant is returned for a planted id`; `an mcp case on a harness without mcp is not applicable`; `the mock directory is never inside the workspace`.
- [ ] **Step 2:** Implement. **Target case 12** (`external-sources-through-mocks`). `git commit -m "feat: mock MCP servers and an mcp tool kind"`.

### Task 29 (item 16): Verify the other four harnesses with a real model

This task needs credentials and model spend, so a person starts it. It is the only task that does.

**Files:** Modify every adapter, `test/fixtures/*.stream.jsonl` (sanitized real captures replace hand-built ones), `docs/src/content/docs/agents/verified.md`, `test/fixtures/README.md`; Create `test/real/cases/{trigger,file-output,subagent}/`, `scripts/capture-streams.sh`

- [ ] **Step 1:** For each of pi, opencode, codex, cursor: run `skill-evals check --json` and the three real cases at `--reps 1` with a real model. Save each stream; sanitize with `scripts/capture-streams.sh` (replaces ids with stable placeholders `id-001…`, paths with `/home/u`, keys with `REDACTED`); commit as parser fixtures.
- [ ] **Step 2:** Fix each parser until its fixture tests pass; add tool kinds `todo` and `question` and map each harness's tools; set `Parsed.askedUser` and record what print mode did with the question (blocked, auto-answered, ended) in the matrix.
- [ ] **Step 3:** Revisit every capability each adapter declares against the real stream; remove any that the capture contradicts; add those it proves. Set `Harness.status`.
- [ ] **Step 4:** Loaded-subject validation: implement for every harness whose stream reports plugins or skills. For the rest, `check` plants a probe skill `probe-<random>` whose body tells the agent to reply with a random token; `subjectLoaded` is true when the token is in the answer. Unit-test the canary on the fake.
- [ ] **Step 5:** Credentials: for each harness, record whether a keychain login survives the relocated home and name the environment-variable route in `guides/ci.md`; correct `authEnv` from Task 3.
- [ ] **Step 6:** Rewrite `verified.md` from the results: status per harness, how the subject is loaded, each capability, what was not verified and why. Gates; `git commit -m "feat: verify pi, opencode, codex and cursor against real streams"`.

Anything that could not be exercised is written into the status table as "not verified", with the reason.

---

## M8: hardening (items 17, 19, 20) and release

### Task 30 (item 17): Sandbox, network policy, canaries, prompt review

**Files:** Create `src/os-sandbox.ts`; Modify `src/session.ts`, `src/checks/observed.ts`, `src/cli.ts`; Test `src/os-sandbox.test.ts`

**Interfaces:**

- `sandboxBackend(): "bwrap" | "sandbox-exec" | null` (by executable on PATH; Linux, macOS). `wrap(backend, command: string[], policy: { writable: string[]; readable: string[]; network: "off" | "provider-only" | "open" }): string[]`. `--sandbox` with no backend: exit 2, `no sandbox backend found (looked for bwrap, sandbox-exec)`. `provider-only` needs an allowlist the backend can enforce; where it cannot, the case is not applicable under `--sandbox` (capability `sandbox` is per machine, computed at start).
- Case key `network: "off" | "provider-only" | "open"` (default `open`); without `--sandbox`, a case with `network` other than `open` is not applicable (never silently open).
- Check `no_writes_outside_workspace`: snapshot of a canary set (the operator's real home dotfiles named by the adapter, the project root) before and after; records pushes to non-local remotes and `npm publish`-style shell calls by matcher. Opt-in.
- `list --show-prompts`; first use of a cases directory (hash of its path and content, remembered under the user's state dir) asks for confirmation on a TTY and refuses without one unless `--yes`.

- [ ] **Step 1: Tests** (argument-level; no real sandbox in CI): `wrap builds the expected bwrap vector`; `--sandbox without a backend exits 2`; `network off without --sandbox is not applicable`; `an unfamiliar cases directory needs --yes when stdin is not a TTY`; `a write to the canary path is recorded`.
- [ ] **Step 2:** Implement; rewrite `safety.md` to cover command checks, setup scripts, mock servers and the sandbox. `git commit -m "feat: an optional OS sandbox, network policy and prompt review"`.

### Task 31 (item 19): Blinding lint

**Files:** Create `src/blinding.ts`; Modify `src/commands/validate.ts`, `src/project.ts`, `src/scope.ts`, `src/report/markdown.ts`; Test `src/blinding.test.ts`

**Interfaces:**

- `DEFAULT_BLINDING_WORDS = ["eval", "test", "judge", "experiment", "rubric", "score", "compare", "benchmark", "candidate", "arena"]`; config `blindingWords: string[]` replaces it. Matching is case-insensitive on word stems (`/\b(word)(s|ed|ing|er|ation)?\b/` plus path segments split on `[-_./]`).
- `scanCase(caseDef, words): Lint[]` over prompts, turn files, variant text, and the paths (file names, not contents) under `workspace/`, the fixtures, `home/`, and whatever setup created (taken from the seed snapshot of a dry `prepareRun`). `"x-unblinded": { words: string[]; why: string }` suppresses those words; `why` is required. The report lists unblinded cases.
- `scanRuntime(paths: string[], envNames: string[], words): string[]` runs once at start over the temp dir prefixes, the subject copy path, the workspace path and the child environment's variable names; any hit is a hard error (it is this tool's bug or the operator's `TMPDIR`). Skill names in the subject are exempt (a skill may be called `arena`).

- [ ] **Step 1: Tests**: `a prompt with "benchmark" warns`; `x-unblinded with a why silences it and without a why is a load error`; `a TMPDIR that contains "test" is reported before any run`; `no variable visible to the agent names this tool` (assert on the fake's `Seen.leaks` equal 0 with the full new environment); `the default list is in the config reference`.
- [ ] **Step 2:** Implement. `git commit -m "feat: lint prompts, paths and the runtime environment for blinding words"`.

### Task 32 (item 20): Held-out prompts

**Files:** Modify `src/cases.ts`, `src/select.ts`, `src/project.ts`, `src/report/markdown.ts`; Test `src/heldout.test.ts`

**Interfaces:**

- `--cases` is repeatable and config `cases` accepts a list; ids are prefixed with the root's basename when more than one root is given; duplicate ids across roots are a load error.
- Variants with `heldout: true` (Task 7) run only with `--heldout`. A root can be marked whole: `--heldout-cases <dir>`.
- Report table per target skill: `trigger recall (dev)`, `trigger recall (held-out)`, `gap`, `false-trigger rate` — recall from cases with `kind: "trigger"` and a `skill_loaded` check on the target; false triggers from `kind: "negative"` cases with `skill_not_loaded`.

- [ ] **Step 1: Tests**: `two roots load with prefixed ids`; `a held-out variant is skipped without --heldout`; `the gap column is dev minus held-out`; `false-trigger rate counts negative cases only`.
- [ ] **Step 2:** Implement; `guides/held-out.md`. `git commit -m "feat: held-out variants and roots, with a dev versus held-out gap per skill"`.

### Task 33: Release 0.1.0

**Files:** Modify `package.json`, `CHANGELOG.md`, `README.md`; Create `docs/src/content/docs/guides/migrate-from-0-0-1.md`

- [ ] **Step 1:** `src/target-cases.test.ts` holds all twelve target cases, each with one matching script and at least one non-matching script per check family it uses. Run it alone: `npx vitest run src/target-cases.test.ts --coverage.enabled=false`. Expected: 12 cases pass, every non-matching script fails on the check it was written for.
- [ ] **Step 2:** Backward-compatibility test `src/compat.test.ts`: a frozen copy of five 0.0.1-style cases and their `results.json` scores, captured from `main` at `182afab` before Task 2; assert equal scores now.
- [ ] **Step 3:** Migration note, containing exactly: strict keys (use `--lenient` for one release, then fix); the skill-load rule change (Task 11); a path with `*`, `?`, `{` is now a glob; exit code 3 for invalid runs; the environment allowlist; `--b` plugin subjects are loaded from a copy.
- [ ] **Step 4:** Move `## Unreleased` to `## 0.1.0`; bump the version; `bash scripts/release-plan.sh` passes its guards.
- [ ] **Step 5:** Full gates. `git commit -m "chore: release 0.1.0"`.

## Target case map

| Target case                        | Completed by | Checks it leans on                                                                                                                 |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1 Routing first-action             | Task 11      | `skill_loaded first` + `ignoring`, `skill_not_loaded`, `tool_called edit`                                                          |
| 2 Red before green                 | Task 15      | `tool_output_matches first/last`, `tool_order`, `file_unchanged`, `command`                                                        |
| 3 Research pipeline shape          | Task 16      | `transcript_matches first_message`, `tool_called sameTurn`, `agent_dispatched`, `tool_order strict`, `by`, `file_count`, `command` |
| 4 Read-only agent under temptation | Task 16      | `tool_not_called by agent`, `file_unchanged`, `output_matches`                                                                     |
| 5 History clean-up                 | Task 13      | `setup`, `SKILL_EVALS_SEED_DIR`, `command`, `tool_not_called`                                                                      |
| 6 Pressure across turns            | Task 24      | `turns[1].checks`, `tool_order which last`, `output_lacks`                                                                         |
| 7 Catch-up from history            | Task 25      | `history`, `tool_not_called write/edit`, `output_matches`                                                                          |
| 8 User-invocable-only skill        | Task 24      | `invoke`, `skill_not_loaded via skill_tool`, `skill_not_available`                                                                 |
| 9 Rule with a precondition         | Task 26      | `preconditions`, `context_injected`, `tool_not_called`, `command`                                                                  |
| 10 Bootstrap ablation              | Task 27      | subject variants, four subjects, noise verdict                                                                                     |
| 11 Kit-editing in isolation        | Task 16      | `subject_unchanged`, `tool_order`, `command`                                                                                       |
| 12 External sources through mocks  | Task 28      | `mcp` kind, `by`, `sameTurn`, `output_matches`                                                                                     |

## Open risks

- **Harness CLI facts.** Session continuation, isolation switches, rule locations, hook events and MCP registration differ per CLI and change between versions. The plan fixes the adapter interface and leaves each CLI's flags to be confirmed from its own `--help` at implementation time. Until Task 29, capabilities outside Claude Code are declared only from fixture evidence, so most new-feature cases will read "not applicable" on four harnesses. That is the intended, honest state.
- **Claude Code isolation.** Organization-managed plugins may not be suppressible by any flag. If so, `--isolated` cannot make the baseline empty there; it will mark those runs invalid and name what loaded. The fix would then be on the machine (an unmanaged CI runner), not in this tool.
- **Size.** Thirty-four tasks. M1 to M3 unlock the consumer's "70% with workarounds" tier without workarounds; M4 to M6 unlock the rest. Each milestone leaves a releasable tool.
