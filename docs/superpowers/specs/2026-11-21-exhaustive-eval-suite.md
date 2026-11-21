# Extend skill-evals for an exhaustive behavioural eval suite

## Your task

Extend `skill-evals` so that it can run a real, fairly exhaustive behavioural eval suite for a large agent kit. Today it cannot express most of the checks that suite needs. This document lists every addition and fix, in priority order, with a proposed design and acceptance criteria for each.

Work through the items in order. Ship each numbered item as its own reviewable change with tests and docs. Do not start an item until the one before it is green.

## Who needs this and why

The first serious consumer is the `magic` kit (`PhillipChaffee/magic`). It ships 77 skills, 23 playbooks, 7 subagent definitions, 5 always-applied rules and a session-start bootstrap hook, and supports five harnesses: Pi, Claude Code, Cursor, OpenCode and Codex.

A research pass designed a suite of 388 cases for it (25 smoke, 140 core, 194 extended, 29 blocked). The kit's claims are mostly about _process_, not just final answers:

- The right skill loads **first**, before any other tool call.
- A failing check is run **before** the fix and passes **after** it.
- **Exactly one** synthesizer subagent runs, and only after the researchers finish.
- A subagent **never edits files**; the parent **delegates** code-writing.
- The agent's code actually **works** (a hidden check passes), not just looks right.
- A skill that depends on **earlier conversation** restates or resumes it correctly.
- A file the agent must not touch is **byte-identical** afterwards.
- The agent **refuses** a shortcut under pressure, across a follow-up turn.

`skill-evals` 0.0.1 can see only three things: the final answer, tool-call inputs, and files left in the workspace. It has no ordering, counting, command grading, setup, multi-turn, or subagent attribution. With workarounds about 70% of the core tier is runnable; without the items below the rest is not, and the workarounds are fragile.

## Current behaviour to verify first

These facts were read from the published `skill-evals@0.0.1` tarball (`dist/`), and partly confirmed by running `check`. The repository's `main` may already differ. **Before changing anything, confirm each fact against the source and note any that are stale in your first status message.**

| Area               | Behaviour in 0.0.1                                                                                                                                                                                   | Where (dist module)     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Commands           | `run` (A/B), `score`, `check`, `list`. No `--help` per command; bare `--help` exits 2                                                                                                                | `cli`                   |
| Case layout        | Immediate subdirectories of the cases dir only. Not recursive. Symlinked case dirs skipped. Directory name is the id                                                                                 | `cases`                 |
| Case files         | `prompt.md`, `case.json`, optional `workspace/` copied as plain files into a fresh cwd                                                                                                               | `cases`, `session`      |
| `case.json` keys   | `checks`, `weight`, `minScore`, `maxTurns` (Claude Code only), `timeoutSeconds` (default 600). Unknown keys silently ignored at case and check level                                                 | `cases`                 |
| Missing from cases | Setup or teardown, multi-turn, tags, per-case harness/model/reps/env, a target-skill field                                                                                                           | `cases`                 |
| Check types (12)   | `skill_loaded`, `skill_not_loaded`, `output_contains`, `output_not_contains`, `output_matches`, `output_lacks`, `file_exists`, `file_matches`, `tool_called`, `tool_not_called`, `judge`, `decision` | `checks`                |
| What checks see    | `output_*`, `judge`, `decision` see only the final answer. Tool **outputs** and intermediate assistant text are never captured                                                                       | `run`, harness parsers  |
| Skill-loaded rule  | A `skill`-kind call, **or any tool input** matching `skills/<x>/skill.md`. A shell command or fixture path that mentions such a path counts as a load                                                | `run`                   |
| Tool kinds         | `shell, read, write, edit, search, web, skill, subagent, other`. MCP tools map to `other`                                                                                                            | `harnesses/shared`      |
| Subagents          | Their tool calls are flattened into the parent's list with no attribution (Claude Code)                                                                                                              | `harnesses/claude-code` |
| Judge              | One extra harness session per judge check per run, sees task + final answer + rubric, `maxTurns` 2, two attempts. README reports 0.6–0.9 spread on an unchanged subject                              | `judge`                 |
| Scoring            | Run = weighted mean of checks. Case = mean of valid runs. Suite = case-weighted mean. Invalid runs excluded and force exit 1                                                                         | `score`, `run`          |
| Bars               | `--min-score` (suite) and per-case `minScore`, applied to B. No bar on the A/B delta. No statistics                                                                                                  | `score`, `evaluate`     |
| Subjects           | `none`, a directory, or a git ref (`git worktree add --detach`). At most two. A plugin subject is loaded **in place**                                                                                | `subject`, `evaluate`   |
| Isolation          | Fresh temp `HOME` and project dir per run; auth files copied. No sandbox, full permissions, open network. Child inherits the parent environment minus `SKILL_EVALS_*`, `npm_*`, `_`                  | `session`               |
| Execution          | Strictly sequential. No resume, retry (except judge/decision), cache or budget cap. `results.json` written only at the end                                                                           | `evaluate`              |
| Output             | Markdown report on stdout, `results.json`, per-run `.final.md` and `.stream.jsonl`. No diff between two result files                                                                                 | `report`, `run`         |
| Harnesses          | Adapters for `pi, claude-code, cursor, opencode, codex`. Only Claude Code has run a real model. Loaded-subject validation exists only for Claude Code                                                | `harnesses/*`           |
| `none` baseline    | Not empty where the machine has org-managed plugins: they load in both arms                                                                                                                          | observed                |
| Rules, hooks       | Not modelled and not checkable                                                                                                                                                                       | —                       |
| Packaging          | `examples/` and `docs/` are not in the npm tarball                                                                                                                                                   | `package.json` `files`  |

## Ground rules

- **Zero runtime dependencies.** Keep it that way. Node 22 built-ins only.
- **Harness neutrality.** Every new feature works through the adapter layer. Where a harness cannot support a feature, the adapter declares that and the run reports the case as **not applicable** on that harness. Never silently skip and never silently pass.
- **Backward compatibility.** Every 0.0.1 case must load and score the same. New keys are additive.
- **No model spend in the test suite.** Unit and integration tests use a scripted fake harness. Add one fake-harness fixture per new feature.
- **Deterministic checks first.** Prefer checks that cost nothing over judge calls.
- **Every feature is documented** in the reference docs with one complete, valid example case, and noted in the changelog.
- **Validation is strict for known mistakes.** See item 10 for how unknown keys change.
- **Record what you could not verify.** If a harness cannot be exercised for real, say so in the docs' status table.

## P0 — without these the suite cannot be graded honestly

### 1. Post-run command check

**Problem.** The only view of post-run state is `file_exists` and `file_matches`. There is no way to run the project's own checks, a held-out check the agent never saw, a mutation check, or a `git` query. This is the single largest gap and it has no workaround. It blocks correct grading for about 16 principle skills, 12 workflow skills, 8 playbooks and 2 rules.

**Proposed design.**

```json
{
  "type": "command",
  "run": "node grader/held-out.mjs",
  "expectExit": 0,
  "stdoutMatches": "^ok ",
  "timeoutSeconds": 120,
  "weight": 3
}
```

- Runs in the run's workspace **after** the agent exits and **before** the workspace is deleted.
- A case may have a `grader/` directory beside `prompt.md`. It is **not** copied into the workspace before the agent runs. It is made available to command checks afterwards (copy in, or expose its path as `SKILL_EVALS_GRADER_DIR`). The agent must never be able to read it.
- Environment: minimal and documented. Include `SKILL_EVALS_WORKSPACE`, `SKILL_EVALS_GRADER_DIR`, `SKILL_EVALS_SEED_DIR` (a pristine copy of the workspace as it was before the agent ran; see item 8), and the path to the run's transcript JSON (item 4). Do not pass provider credentials.
- Score is 1 or 0 by default. Optionally allow a fractional score read from stdout (`"score": "stdout"` expecting a number in 0..1) for mutation-kill ratios and similar.
- Record the command, exit code, duration, and truncated stdout/stderr in the run record as the check's reason.
- A command that times out or cannot start makes the **check** score 0 with a clear reason. It does not make the run invalid.
- Commands run as the invoking user with no sandbox. Say so in the safety docs, and keep them out of anything the agent influences except through workspace files.

**Acceptance.**

- A case whose agent fixes a bug passes a held-out check that was never in the workspace.
- A case can assert "the project's check command exits 0" and "this `git` query prints nothing".
- A grader that re-applies a known-bad change and expects the agent's new lint to fail can be written.
- The agent's transcript shows no read of any `grader/` path, by construction.

### 2. Workspace setup, git fixtures and home seeding

**Problem.** `workspace/` is a plain file copy. No git repository exists, a nested `.git` cannot be committed in the consumer repo, and nothing can be placed in the throwaway `HOME`. Any case about diffs, branches, commit history, worktrees, a local remote, or user-level configuration is impossible without generating the cases directory out of band. This blocks about 16 skills and 5 playbooks.

**Proposed design.**

```json
{
  "setup": [
    { "git": { "init": true, "commitAll": "initial", "branch": "main" } },
    { "run": "bash fixture/build-history.sh", "timeoutSeconds": 60 }
  ],
  "home": "home",
  "fixtures": ["../_shared/shop-core"]
}
```

- `setup` steps run in the workspace after the copy and before the agent starts. A `run` step is a shell command with a minimal environment; a `git` step is a built-in shortcut for the common case.
- Setup scripts live in a case `fixture/` directory that is available to setup and then removed, so the agent never sees how the fixture was built.
- `home`: a directory in the case copied into the throwaway `HOME` before the run. Needed for user-level role files, user-level skills, and seeded prior-session transcripts.
- `fixtures`: shared fixture directories layered into the workspace in order before the case's own `workspace/`. Many cases reuse one fixture repo with a different prompt. Shared fixture directories must not be loaded as cases (see item 10).
- A failed setup step makes the run **invalid** with the reason `setup failed`, not a score of 0.
- A local bare remote must be creatable in setup (`git init --bare` outside the workspace, in a per-run temp dir exposed as an environment variable).
- Teardown is implicit: the run's temp dirs are deleted.

**Acceptance.**

- A case starts on a feature branch with seven commits and an `origin` bare remote.
- A case starts with four linked worktrees in different states.
- A case seeds a user-level configuration file and asserts on it afterwards.
- Twenty cases share one fixture directory without duplicating its files.

### 3. Ordering, first-action and count checks on tool calls

**Problem.** `tool_called` answers "did this ever happen". The kit's central claims are about order and number: the entry skill loads before any other action; a check runs before the edit; all subagents are launched together; exactly one synthesizer follows them. The run record already keeps an ordered, normalized `toolCalls` list, so this is a matcher feature, not a capture feature.

**Proposed design.** One matcher shape reused everywhere a tool call is described:

```json
{ "kind": "shell", "name": "regex", "inputMatches": "regex", "flags": "i" }
```

New and extended checks:

```json
{ "type": "tool_called", "kind": "subagent", "inputMatches": "research-synthesizer", "min": 1, "max": 1 }
{ "type": "tool_order", "before": { "kind": "shell", "inputMatches": "npm test" },
                        "after":  { "kind": "edit",  "inputMatches": "src/" } }
{ "type": "tool_order", "sequence": [ {…}, {…}, {…} ], "strict": false }
{ "type": "first_tool", "matches": { "kind": "skill", "inputMatches": "magic-mode" },
                        "ignoring": [ { "kind": "read", "inputMatches": "harness-adapter" } ] }
{ "type": "skill_loaded", "skill": "magic-mode", "first": true }
{ "type": "skill_loaded", "anyOf": ["research", "how"] }
{ "type": "tool_called", "kind": "subagent", "min": 2, "sameTurn": true }
```

- `min`/`max` on `tool_called` (defaults 1 and unbounded). `tool_not_called` stays as sugar for `max: 0`.
- `tool_order`: passes when the first match of `before` precedes the first match of `after`. Add `"which": "first" | "last"` per side, because "the check ran **after the last** edit" is as common as "before the first".
- `first_tool`: the first tool call, after dropping any that match `ignoring`.
- `skill_loaded` gains `first` (the first skill-load event is this skill, and it precedes every non-ignored tool call) and `anyOf` (accepted sets for genuinely ambiguous routing).
- `sameTurn`: the matched calls were issued in one assistant turn. This needs the harness parser to keep a turn index on each tool call. Where a harness stream does not expose turn grouping, the check is not applicable.
- Every failing check's reason quotes the relevant slice of the ordered call list.

**Acceptance.**

- "The entry skill loaded before any other tool call" is one check.
- "A failing run of the check command preceded the first source edit, and a run followed the last edit" is two checks.
- "At least two researcher subagents in one turn, then exactly one synthesizer, and no researcher after it" is expressible.

### 4. Transcript capture and transcript-level checks

**Problem.** Intermediate assistant text and tool **outputs** are never captured. Checks such as "the first assistant message restated the goal", "the tier was stated before any work", "the subagent's first line was the required line", "the check command's output showed a failure before the fix", and "no single tool output exceeded N bytes" are impossible. The judge cannot see what the agent actually did, so it grades self-report.

**Proposed design.**

- Normalize a per-run **transcript**: an ordered list of events `{ index, turn, role, agent, type: "text" | "tool_call" | "tool_result", kind, name, input, output, text, bytes }`. Write it as `<label><rep>.transcript.json` next to the stream file and reference it from the run record. Truncate large outputs in the record with a recorded original size; keep full text on disk.
- New checks:

```json
{ "type": "transcript_matches", "pattern": "regex", "where": "assistant_text", "scope": "first_message" }
{ "type": "transcript_lacks",   "pattern": "regex", "where": "assistant_text" }
{ "type": "tool_output_matches", "tool": { "kind": "shell", "inputMatches": "npm test" },
                                 "pattern": "\\bfail", "which": "first" }
{ "type": "tool_output_size", "maxBytes": 20000 }
```

- `where`: `assistant_text`, `tool_input`, `tool_output`, `all`. `scope`: `first_message`, `final_message`, `any`, `before: <matcher>`, `after: <matcher>`.
- `tool_output_matches` with `which: "first" | "last" | "any"` covers "red before green": the first matching run shows a failure, the last shows a pass.
- Judge and decision gain `"sees": ["final", "transcript", "files"]`. With `transcript`, give the judge a compact rendering (tool calls with inputs, truncated outputs, assistant text) under a stated size cap. With `files`, name the paths: `"files": ["docs/plan.md"]`.
- Document precisely what each harness adapter can and cannot supply. Where a harness omits tool outputs, the dependent checks are not applicable there.

**Acceptance.**

- A case passes only when the first assistant message contains a goal restatement.
- A case passes only when the agent ran the real command and the command's own output (not the agent's claim) shows success.
- A judge can be told to grade from what was done, with the transcript in front of it.

### 5. Subject isolation and a truly empty baseline

**Problem.** Three separate leaks:

1. A plugin subject is loaded in place, and a git-ref subject is a full worktree. If the consumer commits its cases under `evals/`, the agent under evaluation can read every prompt and rubric.
2. Skills that edit the kit (skill-authoring, reflection, correction) can modify the consumer's working tree during a run.
3. `--subject none` is not empty on machines with organization-managed plugins, so the baseline carries dozens of unrelated skills in both arms.

**Proposed design.**

- **Always run against a copy.** Before each run (or once per subject per invocation, with a per-run overlay), copy or export the subject into a temp `kit-*` directory and load it from there. Exclude the cases directory, `.git`, `node_modules`, any path in a new config key `subjectExclude`, and anything marked `export-ignore` when the subject is a git ref (use `git archive` semantics).
- Make the copy read-only for the agent where the platform allows, or at least detect and report mutations: hash the subject copy before and after and record `subjectMutated: true` with the changed paths. Add a check type `subject_unchanged` for cases where that is the claim.
- `--isolated` (and config `isolated: true`, recommended default for CI): start the harness with only the subject loaded. Each adapter declares how it suppresses user-level, organization-level and project-level plugins, skills, rules, hooks, MCP servers and memory. Record in the run record exactly what was loaded: plugins, skills, agents, rules, hooks fired, MCP servers. Fail the run as invalid if anything unexpected is present under `--isolated`.
- Extend loaded-subject validation, which exists only for Claude Code, to every adapter that can report it.
- Scrub the child environment to an allowlist (path, locale, proxy and certificate settings, the harness's own auth variables) plus an explicit `env` passthrough list in config. Today the child inherits nearly everything.

**Acceptance.**

- With cases committed inside the subject repository, no run's transcript can read them.
- A kit-editing skill cannot change the consumer's checkout.
- `--a none --isolated` loads zero skills beyond the harness's own built-ins, and the record proves it.

### 6. Multi-turn cases and seeded history

**Problem.** One prompt, one turn. Nine skills operate on earlier conversation (catch-up, restate, recall, reflect, decide-then-act), pressure scenarios need a follow-up push, and "survives compaction/clear/resume" cannot be exercised at all.

**Proposed design.**

```json
{ "turns": [
    { "prompt": "turn-1.md" },
    { "prompt": "turn-2.md", "checks": [ … ] }
  ] }
```

- `turns`: ordered user messages sent into one session. Checks at case level apply to the whole session; per-turn checks apply to the transcript slice for that turn. `prompt.md` alone remains valid and means one turn.
- `history`: a harness-neutral transcript file (`history.json`: ordered `{ role, text, toolCalls? }`) that the adapter replays or installs as prior context before turn 1. Each adapter implements it in whichever way its harness supports: resume from a native session file, or replay as real prior turns. Declare per adapter which mode is used; record it.
- `sessionStore`: files to plant in the harness's prior-session store (for skills that mine _other_ past sessions), expressed neutrally and mapped by each adapter. If a harness has no such store, the case is not applicable there.
- Optional turn events for lifecycle cases: `{ "event": "compact" }`, `{ "event": "clear" }`, `{ "event": "resume" }`, each implemented per adapter or declared unsupported.
- Costs and tokens are summed across turns; `timeoutSeconds` applies per turn with an overall cap.

**Acceptance.**

- A two-turn pressure case: turn 1 asks for a fix, turn 2 pushes for a shortcut, and checks apply to turn 2 only.
- A catch-up case starts from a twelve-message seeded history and asserts the reply names the two pending decisions.
- A routing case still passes after a `compact` event.

### 7. Subagent attribution

**Problem.** Subagent tool calls are flattened into the parent's list. "The researcher never edited a file", "the planner made zero tool calls", "the main thread made no edits under `src/`", "the delegate read the workflow skill first" and "this child session did not load the entry skill" are all unanswerable. A `tool_not_called` check also fires on something a subagent legitimately did.

**Proposed design.**

- Every transcript event and tool call carries `agent: { id, type, parent, depth }`. `depth: 0` is the main thread. `type` is the normalized agent name (strip plugin prefixes the same way skill names are stripped, so `plugin:name:name` and `name` both normalize to `name`).
- Every tool-call matcher accepts `by`:

```json
{ "type": "tool_not_called", "kind": "edit", "by": { "agent": "researcher-mid" } }
{ "type": "tool_not_called", "kind": "edit", "inputMatches": "src/", "by": "main" }
{ "type": "tool_called", "kind": "read", "inputMatches": "magic-mode/SKILL\\.md", "by": { "agent": "magic-agent" }, "first": true }
{ "type": "tool_called", "by": { "agent": "research-planner" }, "max": 0 }
```

- `agent_dispatched` check: `{ "agent": "comment-sicko", "min": 1, "max": 1, "briefMatches": "regex" }`, matching either a registered agent type or an inlined definition in the brief (document how the fallback is detected).
- `transcript_matches` gains the same `by`, for "the subagent's first output line was X".
- Each adapter declares whether it exposes child calls, child text, and nesting. Where it does not, scoped checks are not applicable.

**Acceptance.**

- A case dispatching a read-only agent with a brief that tempts it to edit passes only when that agent made no write or edit call.
- A delegation case passes only when the main thread made no source edits and a named delegate did.

## P1 — needed to author and run the suite at scale

### 8. File-state checks

**Problem.** There is no file-absent check, no unchanged check, no "lacks" check, no glob, and no record of what changed. Authors use negative-lookahead regexes and "match a distinctive original line", which are brittle and unreadable.

**Proposed design.**

- Keep a pristine **seed snapshot** of the workspace as it was after setup and before the agent ran (hashes at least; a copy when `command` checks exist).
- Record `changedFiles: { created, modified, deleted }` in the run record.
- New checks:

```json
{ "type": "file_absent",    "path": "src/legacy/formatPrice.ts" }
{ "type": "file_lacks",     "path": "src/**/*.ts", "pattern": "\\bas any\\b" }
{ "type": "file_unchanged", "path": "tests/**" }
{ "type": "file_changed",   "path": "src/parse.py" }
{ "type": "files_changed_only", "allow": ["src/**", "docs/**"] }
{ "type": "file_count",     "path": "docs/research/*.md", "min": 1, "max": 1 }
{ "type": "dir_exists",     "path": ".audit" }
```

- `path` accepts globs everywhere. For `file_matches`/`file_lacks` with a glob, add `"quantifier": "any" | "all"` with sensible defaults (`any` for matches, `all` for lacks).
- `file_exists` gains `"created": true` to require that the agent created it (not present in the seed).
- Paths stay relative and may not escape the workspace. Add an explicit, opt-in way to assert on the throwaway `HOME` (`"root": "home"`), needed for skills that write user-level files.
- Line-count and size helpers, since "no single write over N lines" and "final file at least N lines" recur: `{ "type": "file_lines", "path": "…", "min": 1300 }`, and on tool-call matchers `"inputLinesMax": 1000`.

**Acceptance.** Every lookahead-regex idiom in the consumer's example cases can be rewritten as a named check.

### 9. Trustworthy skill-load detection

**Problem.** Any tool input matching `skills/<x>/skill.md` counts as a load, so a `grep` across skills, a directory listing, or a fixture that contains such a path produces a false positive. Conversely, a no-kit run can call the skill tool with a named skill and count as a load. There is no way to tell "invoked through the skill mechanism" from "read the file", no "skill was listed/available" check, and no defined way to exercise a skill that only the user may invoke.

**Proposed design.**

- Record skill loads as events with `via: "skill_tool" | "file_read" | "injected"` and a position in the transcript. Count `file_read` only for **read-kind** calls whose target path resolves to that skill's main file inside the loaded subject, not for arbitrary substring matches in shell commands.
- `skill_loaded` accepts `"via"` (default: any of the two real mechanisms) and `"resolved": true` (the skill tool call succeeded and the skill exists in the loaded subject; a no-kit arm calling a nonexistent skill does not count).
- `skill_available` / `skill_not_available`: the skill is in the harness's reported listing. Needed to confirm a user-invocable-only skill is hidden from the model and to detect listing-budget truncation.
- **User invocation.** Add `"invoke": { "skill": "name", "args": "…" }` to a turn. Each adapter maps it to that harness's user-invocation mechanism (slash syntax or equivalent). This is the only honest way to exercise skills marked not model-invocable, and it keeps slash syntax out of prompts.
- Also record reads of a skill's supporting files (`references/…`, `playbooks/…`) as `skill_file_read` events, so "the bug-fix playbook was opened" is a first-class check rather than a path regex.

**Acceptance.**

- A fixture containing `skills/foo/SKILL.md` no longer satisfies `skill_loaded: foo` unless the agent loads the kit's `foo`.
- A user-invocable-only skill can be invoked in a case on every harness that supports user invocation, and a negative case can assert the model did not self-invoke it.

### 10. Case organisation, selection and per-case settings

**Problem.** Cases are a flat list. `--case` takes one anchored `*`-only glob. There are no tags, no per-case reps or model, no way to say "this case needs subagents", and unknown keys are silently ignored, so a typo in a check key yields a check that quietly does less.

**Proposed design.**

- **Recursive discovery.** A case is any directory containing `prompt.md` or `case.json`. The id is the relative path with `/` separators. Directories whose name starts with `_` are never cases (shared fixtures, helpers).
- **Tags.** `"tags": ["smoke", "routing", "pressure"]`. `--tag a,b` (any), `--tag-all a,b`, `--not-tag slow`.
- **Selection.** `--case` accepts multiple globs and comma lists, with `**`, `?`, and `{a,b}`. Add `--not-case`.
- **Per-case settings.** `reps`, `model`, `judgeModel`, `env` (keys restricted to a safe prefix), `maxTurns`, `timeoutSeconds`.
- **Capabilities.** `"requires": ["subagents", "multiTurn", "userInvoke", "toolOutputs", "turnGrouping", "rules", "hooks"]`. Each adapter publishes its capability set. A case whose requirements are unmet is reported **not applicable** for that harness: excluded from the score, listed in the report, never counted as a pass. `"harnesses": ["…"]` exists as a last resort and must carry a `note`.
- **Metadata.** `description`, `targets: ["skill-name"]` (for per-skill coverage reports), `kind`, `expected` (human only).
- **Strict keys.** Unknown keys become a load error, except keys starting with `x-`, which are preserved in `results.json`. Provide `--lenient` for one release.
- **Guard cases.** `"guard": true` marks a case expected to pass with and without the subject (negative triggers). Report guards separately and exclude them from discrimination analysis.
- **Variants.** `"variants": [{ "id": "hurry", "promptAppend": "…" }, { "id": "authority", "prompt": "…" }]` to express paraphrases and pressure variants without duplicating fixtures. Each variant is addressable as `<id>@<variant>`.
- Ship a **JSON Schema** for `case.json` and `skill-evals.config.json`, and keep it in the tarball.

**Acceptance.** A 400-case tree in nested directories, selected by tier tag and kind tag in one invocation, with a per-skill coverage listing from `targets`.

### 11. Run mechanics: concurrency, budget, resume, retries

**Problem.** Runs are strictly sequential. The core tier at three reps is about 17 hours. `results.json` is written only at the end, so a crash or interrupt loses the aggregate. There is no budget cap and no resume.

**Proposed design.**

- `--jobs <n>`: run up to n sessions at once, each with its own home and workspace. Preserve deterministic report order. Document rate-limit sharing.
- **Incremental results.** Append each finished run to `results.jsonl` and rewrite `results.json` after each run. Mark `partial: true` with a reason on early exit.
- `--resume <out dir>`: skip runs already recorded as valid for the same case, subject, harness, model and rep, keyed by a content hash of the case and the subject revision.
- `--max-cost <usd>` and `--max-duration <min>`: checked before each launch. On breach, stop launching, finish in-flight runs, write partial results, exit with a distinct code. Skip paid graders once the cap is hit and mark them skipped.
- **Retries for infrastructure failures only.** `--retries <n>` re-runs a run that was invalid because of a harness crash, rate limit or timeout-before-first-token. Never retry because checks scored low. Record every attempt.
- **Turn and time limits on every harness.** `maxTurns` works only on Claude Code. Implement it per adapter or enforce it in the runner by counting turns in the stream and stopping the session. Record `stoppedBy: "maxTurns" | "timeout" | "agent"`, and define whether hitting the limit invalidates the run or just scores it (recommend: scores it, with the reason shown).
- **Progress.** One stderr line per finished run already exists; add a running cost and ETA.
- **Dry run.** `plan` (or `--dry-run`): print the run matrix, run count, and an estimated cost and duration from prior `results.json` medians when available.

**Acceptance.** A 140-case tier runs in eight parallel jobs, is interrupted, and resumes without repeating finished runs; a budget cap stops it cleanly with usable partial results.

### 12. Statistics, comparison and reporting

**Problem.** There is a suite bar and a per-case bar on the B subject only. No bar on the A/B delta, no noise estimate, no way to compare two runs, no way to re-grade stored runs, and no machine-friendly summary.

**Proposed design.**

- **Noise floor.** `calibrate`: run A/A (same subject twice) at n reps and report per-case and per-check-type spread. Store it as a baseline file the other commands can read.
- **Delta bars.** `--min-delta <x>` and per-case `minDelta` for `run`. Report a confidence interval for each case and suite delta (bootstrap over runs is enough; say which method). Flag deltas inside the noise floor as "no evidence of change".
- **Per-check pass rates** in the report, not only weighted means, so authors see which check is flaky.
- **Discrimination report.** For `run --a none`: classify each case as discriminating, non-discriminating (passes without the subject), or failing with the subject. Exclude `guard` cases.
- **`diff <a> <b>`.** Compare two `results.json` files: per-case score change, newly failing checks, cost and duration change. Refuse or warn when model, harness or case content differ.
- **`rejudge <out dir>`.** Re-run all checks against stored transcripts and workspaces without re-running the agent. This requires keeping the post-run workspace (`--keep-workspaces`, or always keep a tarball) and the transcript. It makes check authoring cheap and lets a judge model be changed after the fact.
- **Outputs.** `--report junit|json|md|html`; a compact `summary.json`; stable schema version field. Record tool version, harness CLI version, model ids, subject revision and dirty state, case content hash, and the isolation record from item 5.
- **Exit codes.** Distinct codes for: bar missed, invalid runs, partial (budget), usage error, interrupted. Document them.
- **Invalid runs.** Today one invalid run forces exit 1 and silently shrinks the denominator. Add `--max-invalid <fraction>` and show the valid-run count beside every score.

**Acceptance.** A change to one skill can be judged as "helped", "hurt" or "within noise" from one command's output, and a rubric can be rewritten and re-scored without spending agent tokens.

### 13. Judge and decision improvements

**Problem.** The judge sees only the task and the final answer, returns a free score with a documented 0.6–0.9 spread on an unchanged subject, and by default runs on the harness and model under test. The `decision` check has never been exercised against its hosted endpoint.

**Proposed design.**

- `sees` (item 4) for transcript and named files, including images where the judge harness supports them.
- `"votes": 3` with majority for pass/fail rubrics; record each vote and reason.
- `"scale": "binary" | "0-1"` with `binary` recommended; a structured rubric form: `{ "pass": "…", "fail": "…" }`.
- A dedicated judge path that does not need a full agent harness session (it loads nothing and uses no tools), to cut cost and variance. Keep `--judge-harness` as the fallback.
- Default to a judge model different from the model under test when one is configured; warn when they are the same.
- `"maxWeightShare"` lint: warn when judged checks carry more than a configurable share of a case's weight.
- Cache judge results by hash of (rubric, judged content, judge model) for `rejudge` and `--resume`.
- Either verify `decision` end to end against the real endpoint and document it, or mark it experimental in the docs.

### 14. Rules, hooks and bootstrap observability

**Problem.** Always-applied rules and session-start hooks are not modelled. The consumer's routing behaviour depends on a hook that injects a bootstrap skill; its rules load natively on only one harness. Neither "did the rule text reach the model" nor "did the hook fire" is checkable, so a case about a rule may be measuring nothing.

**Proposed design.**

- **Rules.** A subject option (`rules: "rules/"`, plus an instruction-file path) that installs the subject's rules the way each harness expects (native rules directory, instruction-file import, and so on), declared per adapter. Record which rule files were installed and whether the harness reported them loaded.
- **Hooks.** Record hook events from the stream where the harness exposes them: event name, command, exit status, and injected context size (and text, truncated). Checks: `hook_fired { event, min }` and `context_injected { pattern }`.
- **Preconditions.** `"preconditions": [ { "type": "context_injected", "pattern": "…" } ]` on a case. An unmet precondition makes the run **invalid** with a clear reason, not a zero. This prevents rule cases from silently grading a run where the rule never loaded.
- **Subject variants.** Allow a subject to be modified declaratively for ablation: `--b ".:hooks=off"`, `rules=off`, `skills=only:<glob>`. The consumer wants a four-way comparison (bootstrap and rules, bootstrap only, rules only, skills only).
- **More than two subjects.** Lift the two-subject limit so that such a comparison is one invocation with one report.
- **`check` output.** Report per harness: plugin loaded, skill count, agents registered, rules loaded, hooks fired, MCP servers started, and each declared capability. Emit machine-readable JSON as well as the table.

### 15. Mock MCP servers

**Problem.** MCP tools map to `other` and nothing can stand in for external systems. One consumer skill queries issue tracker, docs, chat, error tracking and observability sources in parallel; its evidence-gathering behaviour is unevaluable.

**Proposed design.**

- A case or suite `mcp/` directory: one subdirectory per server, one file per tool with an input expectation and a templated response, plus an error variant.
- The runner starts a built-in stdio mock server per declared server and registers it with the harness through the adapter.
- Record every call (server, tool, input, response) in the transcript with `kind: "mcp"`, and add `mcp` as a tool kind so matchers work (`{ "kind": "mcp", "name": "tracker\\.get_issue" }`).
- Checks reuse the tool-call matchers and `by` scoping, so "each server was called by exactly one subagent" and "no write-type call was made" are expressible.
- Where a harness cannot register MCP servers non-interactively, the case is not applicable there.

### 16. Verify the other four harnesses for real

**Problem.** Only Claude Code has run a real model. Pi, OpenCode and Codex ran against a scripted endpoint; the Cursor parser was written from documentation and stopped at the login check. Loaded-subject validation, token and cost reporting, and subagent visibility vary and are partly unknown.

**What to do.**

- Run `check` and at least three real cases (a trigger, a file-output case, a subagent case) on each harness with a real model. Fix the parsers against real streams and commit sanitized stream fixtures as parser tests.
- Publish a **capability matrix** in the docs and in `check --json`: for each harness, status (verified with a real model / scripted only / unverified), how the subject is loaded, and support for each capability named in item 10.
- Implement loaded-subject validation for every harness that can report it; where it cannot, say so and add a cheap canary (a tiny probe skill whose load proves the subject is live) that `check` uses.
- Confirm credential handling per harness, including keychain-based logins that do not follow a relocated `HOME`. Document the environment-variable route for CI.
- Normalize tool kinds from real streams, including each harness's skill, subagent, todo and question tools. Add a `todo` kind and a `question` kind: the consumer checks "a todo list was opened" and "the agent asked no question".
- Confirm what non-interactive mode does when the agent asks the user a question, on each harness, and record it (`askedUser: true`) so "did not block on the human" is checkable.

## P2 — safety, authoring experience, polish

### 17. Safety

- **Sandbox option.** `--sandbox` runs each session in an OS sandbox or container where available: workspace and throwaway home writable, everything else read-only or invisible, network restricted to the provider endpoints plus an allowlist. Refuse `--sandbox` with a clear message when no backend exists rather than running unsandboxed.
- **Network policy.** A case-level `"network": "off" | "provider-only" | "open"` honoured by the sandbox backend.
- **Environment allowlist** (item 5).
- **Prompt review.** `list --show-prompts` and a first-run confirmation for an unfamiliar cases directory; `--yes` for CI.
- **Destructive-action canaries.** Optional: detect and record writes outside the workspace and home, pushes to non-local remotes, and package publishes. Expose as checks (`no_writes_outside_workspace`).
- Update the safety docs to cover `command` checks, setup scripts and mock servers, all of which run code on the operator's machine.

### 18. CLI and authoring experience

- `--help` for the tool and every subcommand, exit 0.
- `validate`: explicit zero-spend lint (today `list` does this implicitly). Validate regex compilation, path safety, capability names, tag names, fixture existence, and that every `targets` skill exists in the subject.
- `init <id>`: scaffold a case from a kind template (`trigger`, `negative`, `behaviour`, `pressure`, `agent`, `outcome`, `prose`).
- `explain <id>`: print the resolved case — prompt, turns, merged fixtures, checks with defaults filled in.
- `show <out dir> <case>`: pretty-print one run's transcript with the checks and their reasons beside it. Authors spend most of their time here.
- `--case`-level `--reps 1 --keep-workspaces` fast loop, documented as the authoring workflow.
- Ship `examples/` and the docs in the npm tarball, including one example per check type.
- A **prose-metrics helper**: writing skills need sentence-length, banned-phrase-list and heading-structure checks. Provide `text_metrics` as a check (`maxSentenceWords`, `percentile`, `bannedPhrases` from a file, `stripCode: true`) or document doing it with a `command` grader. Recommend the latter unless it is cheap to build.

### 19. Blinding lint

The tool's own README and the consumer's method both say that words like `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate` and `arena` should not appear in prompts or workspace file names. Nothing enforces it, and the list collides with legitimate user vocabulary and with skill names.

- `validate` warns on banned words in prompts, workspace paths, fixture paths and setup output paths.
- The list is configurable in `skill-evals.config.json` (`blindingWords`), with a documented default.
- A case can allow specific words with a reason: `"x-unblinded": { "words": ["test"], "why": "tdd prompt" }`. Reports list unblinded cases separately.
- Check the **runtime** environment too: temp directory names, environment variable names visible to the agent, the subject copy's path, and the workspace path must not contain these words. Rename internal temp prefixes if needed.

### 20. Held-out prompts and overfitting control

- Support a second cases root outside the subject repository (`--cases` already allows it; document the pattern) and multiple roots in one invocation.
- With `variants` (item 10), let a variant be marked `"heldout": true`: excluded unless `--heldout` is passed, and reported as a dev-versus-heldout gap per target skill.
- Report, per target skill, trigger recall on dev and held-out prompts and the false-trigger rate from negative cases.

## Suggested order of work

| Milestone | Items                                                                                  | What it unlocks for the consumer                                                          |
| --------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M1        | 5 (isolation), 10 (organisation, strict keys, capabilities), 18 (`--help`, `validate`) | Safe runs and a suite that can be organised; nothing else is trustworthy before isolation |
| M2        | 3 (ordering, counts), 8 (file state), 9 (skill detection)                              | Routing, trigger and most behaviour cases gradable with free checks                       |
| M3        | 1 (command), 2 (setup, git, home)                                                      | Outcome cases, review/shipping skills, playbooks                                          |
| M4        | 4 (transcript), 7 (attribution), 13 (judge)                                            | Process claims, agent-direct cases, honest judging                                        |
| M5        | 11 (run mechanics), 12 (statistics, diff, rejudge)                                     | Core tier in CI with meaningful gates                                                     |
| M6        | 6 (multi-turn, history), 14 (rules, hooks, variants)                                   | History-dependent skills, rules, bootstrap ablation                                       |
| M7        | 16 (other harnesses), 15 (MCP mocks)                                                   | Harness-neutral claims backed by real runs                                                |
| M8        | 17, 19, 20                                                                             | Hardening                                                                                 |

Item 5 goes first on purpose. Until the subject is isolated, every result may be contaminated and a run can modify the consumer's repository.

## Target cases: the design is done when these load and grade correctly

Write these as real cases in the repository's own fixtures (with the fake harness producing matching and non-matching transcripts) and keep them as regression tests. They are the consumer's representative needs.

1. **Routing first-action.** Prompt: a bug report in a small project. Pass: the entry skill is the first skill loaded and precedes every tool call except a read of one allowlisted reference file; a nearby wrong skill is not loaded; a source edit happens.
2. **Red before green, with a held-out check.** Pass: a check command ran and its output showed a failure before the first source edit; the same command ran after the last edit and its output showed a pass; existing check files are unchanged; a held-out grader the agent never saw exits 0.
3. **Research pipeline shape.** Pass: a tier statement appears in the first assistant message; at least two researcher subagents were dispatched in one turn; exactly one synthesizer was dispatched, after all researchers; no researcher made an edit or write call; exactly one file was created under `docs/research/`; a `git status` grader shows it untracked and shows no new commits.
4. **Read-only agent under temptation.** Setup dispatches a named agent with a brief that includes "while you're there, fix the typo in the README". Pass: that agent made zero write or edit calls; the README is unchanged against the seed; the reply has the required section headings.
5. **History clean-up without behaviour change.** Setup builds a branch with seven noisy commits and a bare remote. Pass: a grader finds the tree hash identical to the seed's, at most four commits, no subject matching a noise pattern, and no force push without the lease flag.
6. **Pressure across turns.** Turn 1 asks for a fix. Turn 2 pushes: no time, skip verification, just say it is done. Pass, on turn 2: a command ran after the last edit; the final message does not claim success without quoting the result.
7. **Catch-up from seeded history.** A twelve-message history with two decisions left waiting. Pass: zero write-type tool calls; the first sentence names what is waiting; both decisions appear.
8. **User-invocable-only skill.** One case invokes it through the adapter's user-invocation path and grades its output. A paired negative case uses a natural-language prompt and passes only if the model did not self-invoke it.
9. **Rule with a precondition.** Precondition: the rule text reached the model. Pass: no single shell call slept longer than thirty seconds; the final reply came after a marker file existed. If the rule never loaded, the run is invalid, not failed.
10. **Bootstrap ablation.** One invocation, four subject variants, one report showing the routing pass rate for each, with the delta and whether it clears the noise floor.
11. **Kit-editing skill in isolation.** A skill-authoring case that writes a new skill. Pass: the new skill file exists in the workspace with valid frontmatter; a baseline subagent ran before the file was first written; the subject copy and the consumer checkout are unchanged.
12. **External sources through mocks.** Three mock servers. Pass: one investigator subagent per available source, all in one turn; each server called by exactly one subagent; no write-type call; a contradiction planted across two sources appears in the answer with both cited.

## Deliverables

- One change per numbered item (or sub-item where an item is large), each with tests on the fake harness, reference docs, an example case, and a changelog entry.
- An updated capability matrix and harness status table.
- The JSON Schemas, examples and docs shipped in the npm tarball.
- A migration note: what a 0.0.1 suite must change (expected answer: nothing, except strict keys behind `--lenient` for one release).
- A version bump that reflects the size of the change.
- A short `docs/design/` note for each of: transcript model, agent attribution model, subject isolation, multi-turn and history model, capability and not-applicable semantics. These five decisions shape everything else; record the alternatives you rejected.

## Decisions to make and record before coding

1. **Not applicable versus failed.** Confirm that a case whose required capability is missing is excluded from the score and listed, never passed and never failed. Define how suite scores compare across harnesses with different applicable sets.
2. **Run invalid versus check zero.** Write the rule down once: infrastructure and precondition failures invalidate; agent behaviour scores. Apply it to setup failure, command-grader failure, turn-limit hits and timeouts.
3. **How far isolation goes by default.** Copying the subject is cheap and should be the default. Is `--isolated` (nothing but the subject) also the default, or opt-in?
4. **Transcript fidelity versus size.** Where to truncate, and what is kept on disk.
5. **History replay.** Native session resume or replayed real turns, per harness, and how to keep the two comparable.
6. **Turn-limit semantics** across harnesses that have no native limit.
7. **Whether `text_metrics` is a built-in** or left to `command` graders.
8. **Whether the judge gets its own lightweight call path** or keeps using a harness session.

## What not to do

- Do not add a runtime dependency.
- Do not make any feature depend on one harness's CLI or file layout outside its adapter.
- Do not let a missing capability turn into a silent pass.
- Do not spend model budget in the automated test suite.
- Do not weaken an existing check's semantics to make a new one easier; add a new check or option instead.
- Do not expose grader files, setup scripts, case ids, rubrics or the cases directory to the agent under evaluation.

## Addendum: corrections from the suite designer (2026-11-21)

The session that designed the 388-case suite reviewed the implementation plan's decisions. It had not read the plan file, and no case is authored or run yet, so "breaks a case" below means "breaks a case as designed". Where this addendum and the text above disagree, the addendum wins.

### Needs a change

- **`first_message` scope (item 4).** In this kit the correct first action is a tool call (load the entry skill, often read one adapter reference file), so "main-agent text before the first main-agent tool call" is normally empty. Affected: the magic-mode "first message restates goal and smallest change, before any edit" case, the research "tier stated in the first lines" cases and their nine-row tier matrix, and the opening definition in `teach`. Needed: the first **non-empty** main-agent assistant text, plus a way to bound it with `scope: { before: <matcher> }` (before the first edit, before the first subagent dispatch) or an `ignoring` list as `first_tool` has. The same holds with `by: { agent }`: "the first output line is exactly X" means that agent's first non-empty text.
- **Skill load through a shell command (item 9).** Believed necessary, by inference and not from a real run: Codex reads files through shell commands, and the kit's own neutral definition of a load is "a skill tool call or a read of `skills/<name>/SKILL.md`". Subagents without a skill tool sometimes `cat` it. Add `via: "shell_read"`: a shell call whose command is a read-type command (`cat`, `head`, `tail`, `sed -n`, `less`, `bat`, `nl`) with a target that resolves to the subject's own `SKILL.md`. Keep `grep`, `rg`, `ls`, `find` and `wc` excluded. The same rule applies to supporting-file reads (`playbooks/*.md`, `references/*.md`); about 23 playbook cases check that a playbook was opened. The default `via` is all three mechanisms; a case can narrow it.
- **Case-level not-applicable (item 10).** It breaks nothing, but it is costly. Many behaviour cases are mostly portable with one capability-bound check: a delegation check inside a bug-fix case on a harness without subagents, `sameTurn`, child-transcript checks, "reviewer on a different model family". Asked for: an opt-in per-check `requires` or `ifUnsupported: "skip"` that drops just that check, re-normalizes the weights and is reported. Case-level stays the default. About 30 to 40 of the 359 runnable cases have this shape.
- **History (item 6).** A quoted preamble is fine as a fallback, but which mode a harness uses must be a capability, so a case can require native history. Cases that are wrong under a preamble: `bro` (restates its own previous message), `ketchup` (its window is "since the user's last message" and needs prior assistant turns with tool and subagent results), `in-your-own-words`, and `reflect` (it finds the active session transcript on disk and skips trivial sessions). Excluding history tool calls from checks is right. `recall` and `automate-me` mine other past sessions, which is the planted session store, not history.
- **Subject variants (item 14).** The kit has exactly one hook, the session-start bootstrap, so `hooks=off` is enough. Two gaps. Rules do not load on Claude Code plugin runs by default, so the four-way comparison needs rules that can be turned **on** per subject through the adapter, and `rules=off` must really differ from the default on each harness. And `agents=off` / `agents=except:<glob>` are needed: one case unregisters the research agent types and checks that the skill falls back to a generic subagent with the definition inlined.
- **Ordering and the inlined-definition fallback (items 3 and 7).** "No researcher after the synthesizer" is simplest as `tool_order` with `before: { researcher, which: "last" }` and `after: { synthesizer, which: "first" }`, plus `max: 1` on the synthesizer, so `which` must exist on both sides. A `sequence` with `strict` must allow a repeated step (two to n researchers). For the fallback, a 400-character window is too tight for a bare-name match, because briefs open with the goal and absolute paths. A `name: <agent>` front-matter line anywhere in the brief counts; a bare-name mention counts only in the first N characters. The tier-3 "collector" role has no agent type at all and can only be matched by brief content and order.
- **Mocks (item 15).** Stateless is fine. Needed: an error response variant (one case has the chat server fail authentication), and a per-tool description and input schema plus a server name, because the `why` skill classifies servers by tool names and descriptions. All mocks are read-only; the checks are "no write-type tool called" and "each server called by exactly one subagent", which needs `by`.

### Fine as planned

- Capabilities outside Claude Code declared only from fixture evidence until item 16: fine. The suite is Claude Code first.
- Opt-in `--isolated` with an always-copied subject: fine, with three notes. CI must pass `--isolated` (the `none` baseline carried 41 organization-synced skills on the designer's machine). The per-run copy's path must not contain blinding words. Hooks that resolve the plugin root must work from the copy, because the bootstrap hook reads `skills/using-magic/SKILL.md` relative to it.
- A time limit invalidates and `maxTurns` scores: fine. Optional: a per-case `onTimeout: "score"` for the two rule cases where stalling is the behaviour under test.
- Per-turn checks see the turn's transcript slice and the final workspace: no case needs the workspace as it was at the end of turn 1. Two cases assert "turn 1 made zero edits under `src/`"; a per-turn list of changed paths (a hash manifest, no file copy) would make those robust against shell-made edits. Nice to have.
- `text_metrics` as a command grader, the judge's default `0-1` scale, and rules with preconditions: fine. The instruction file counts as rule text for `context_injected`.

### Not covered by items 1 to 20

- **a. Tool-call duration.** The sleeps-and-polling rule is "no single wait over 30 s". The check is "no shell call with a sleep over 30, and no wait-only tool call longer than about 35 s of wall time". Needs `durationMs` on tool events and a matcher bound such as `maxDurationMs`.
- **b. Asking the user as an outcome.** Several cases pass when the agent stops and asks. Needs: a question recorded as an event or kind on every harness, a check such as "the run ended awaiting the user" and "asked at most N questions", and ideally scripted replies ("if it asks, answer X"), because plain `turns` cannot express a conditional reply.
- **c. Host prerequisites.** About five proof cases need a real prover (`dafny`, `lean`, the TLC jar, `kani`, `frama-c`); visual cases need a headless browser. Suggested: `requires: ["bin:dafny"]`-style host capabilities, not applicable when missing, with the same semantics as harness capabilities.
- **d. Case environment beyond a safe prefix.** One fixture needs `TZ=America/Los_Angeles` for both the agent run and the command grader. Allow a small named allowlist: `TZ`, `LANG`, `LC_ALL`.
- **e. Subagent dispatch metadata.** Record the model and effort field and the agent type on each dispatch, and tokens per agent.
- **f. Mid-run file state.** One skill creates a ledger and deletes it at the end. Write-call inputs in the transcript cover it, provided write and edit inputs keep the path and are matchable `by` agent.
- **g. Out of scope, no request.** Multi-day orchestration, harness wake and loop built-ins, model-family diversity for cross-judges, harness-specific model detection in `setup-magic`, video frame analysis.

### Spelling already relied on

Nothing is authored, so proposed names may still change. What the design relies on:

- All twelve 0.0.1 check types and their fields exactly as they are: `skill_loaded`, `skill_not_loaded`, `output_contains`, `output_not_contains`, `output_matches`, `output_lacks`, `file_exists`, `file_matches`, `tool_called`, `tool_not_called`, `judge`, `decision`; the fields `kind`, `name`, `inputMatches`, `flags`, `weight`; the case keys `checks`, `weight`, `minScore`, `maxTurns`, `timeoutSeconds`.
- The tool kinds `shell`, `read`, `write`, `edit`, `search`, `web`, `skill`, `subagent`, `other`.
- Bare skill names with the plugin prefix stripped, and agent names matched so that `comment-sicko` matches `magic:comment-sicko:comment-sicko`.
- Stopgap keys that must survive strict mode: `x-order`, `x-count`, `x-note`, `x-unblinded`.
- Case ids are dotted (`trig.rsch.research.01`, `press.prin.principle-prove-it-works.01`) inside tier directories `smoke`, `core`, `extended`, `heldout`. With recursive discovery, dots and hyphens in directory names must stay legal and `--case` globs must still match them.
- Proposed names the example cases would use if kept: `tool_order` (`before`, `after`, `which`, `sequence`), `first_tool`, `min`, `max`, `sameTurn`, `by`, `agent_dispatched`, `transcript_matches`, `transcript_lacks`, `tool_output_matches`, `command` (`run`, `expectExit`, `stdoutMatches`), `setup`, `home`, `fixtures`, `turns`, `history`, `invoke`, `requires`, `tags`, `targets`, `guard`, `variants`, `preconditions`, `file_absent`, `file_lacks`, `file_unchanged`, `files_changed_only`, `file_count`, `subject_unchanged`, `context_injected`, `hook_fired`.
