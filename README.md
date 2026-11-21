# skill-evals

![coverage](https://coveralls.io/github/PhillipChaffee/skill-evals/badge.svg?branch=main)

`skill-evals` measures what an agent does when your skills are loaded. It runs a set of prompts in a real coding-agent harness, scores every run from 0 to 1, and can fail when a score is under a bar you set. It scores one set of skills, or it compares two: a baseline (A) and a change (B), or no skills at all and your skills.

It works with Claude Code, Codex, Cursor, OpenCode, and Pi. It needs Node 22 or later and at least one of those harnesses installed. It has no dependencies. It runs on macOS and Linux.

Every run is unattended and has full permissions in its harness. The agent can run commands and write files on your machine without asking, so only run prompts you wrote or read.

## Install

```sh
npm install --save-dev skill-evals   # or run it without installing: npx skill-evals <command>
```

## A first case

Run this in the folder that holds your skills. Replace `greet` with the name of one of your skills, and the prompt with a request that should make the agent use it.

```sh
mkdir -p evals/cases/greeting
echo 'Give me a greeting to start my day.' > evals/cases/greeting/prompt.md
echo '{ "checks": [{ "type": "skill_loaded", "skill": "greet" }] }' > evals/cases/greeting/case.json
npx skill-evals check                              # which harnesses work on this machine
npx skill-evals run --a none --model <model-id>    # A = no skills, B = your skills
```

The report shows how often the agent loaded the skill without your skills (0 of 3) and with them. [`examples/cases/hello`](examples/cases/hello) in the repository is one more case you can copy.

Each run starts in a new, empty home directory, so your own settings and default model are not there. Pass `--model`, or set `model` in the [config file](#config-file). Without it each harness uses its built-in default, which may be a provider you have no key for.

## Subjects

A subject is what a run loads into the harness. You name it with `--subject`, `--a`, or `--b`.

| You pass                                                             | Kind     | What the run loads                                                                                        |
| -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| A directory, or a git ref of the project, that has a plugin manifest | `plugin` | The directory, the way each harness loads a local plugin. Hooks and rules that the plugin ships load too. |
| Any other directory or git ref                                       | `skills` | Each skill in it, copied to the place where the harness discovers a user's skills.                        |
| `none`                                                               | `none`   | Nothing. This is the baseline for "does the skill change anything".                                       |

- **Project.** The project is the git repository that holds the working directory, or the working directory itself when it is not in a repository. The default subject is the project folder, with its uncommitted changes.
- **Directory.** A directory is used as it is on disk. A relative path resolves against the working directory. For a folder that is named `none`, write `./none`.
- **Git ref.** Anything that is not a directory must be a git ref of the project. It is checked out into a detached worktree in a temp directory, and the worktree is removed when the command ends, on failure and on Ctrl+C too. The report prints the commit, so a stale local `main` is visible.
- **Plugin manifest.** A directory is a plugin when its root has `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin.json`, `.opencode/plugins/`, or a `package.json` with a `pi` key. A plugin loads only in the harnesses it has packaging for.
- **Skills folder.** The skills are every `<dir>/<name>/SKILL.md` and `<dir>/skills/<name>/SKILL.md`, and `<dir>/SKILL.md` itself, which is one skill named after the folder. The name of a skill is the name of its folder, and the `name` in its front matter must be the same. A folder with no skill is an error.

Where a `skills` subject goes, inside the run's own home directory:

| Harness       | Location                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `claude-code` | `~/.claude/skills/<name>/`                                                                              |
| `cursor`      | `~/.cursor/skills/<name>/`                                                                              |
| `codex`       | `~/.agents/skills/<name>/`                                                                              |
| `opencode`    | `~/.agents/skills/<name>/`                                                                              |
| `pi`          | `~/.pi/agent/skills/<name>/`, each named with `--skill` because the run switches Pi's own discovery off |

The files are copied, not linked, and `.git` and `node_modules` are left out. A skill of the same name that you installed globally does not load, because your real home directory is not the run's home.

With `none`, and with every other subject, the harness still loads what it ships with. Some harnesses also fetch plugins that your organization manages. Claude Code did that in the runs behind this document.

## Commands

| Command | What it does                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run`   | Runs every case against A and B, `--reps` times each, one run at a time, and scores both.                                                                                                                                                                                                                                                  |
| `score` | Runs every case against one subject and scores it.                                                                                                                                                                                                                                                                                         |
| `check` | Runs one small prompt in each installed harness. Reports whether the harness ran, whether it reported the subject as loaded, which skills the agent loaded, and which record fields the adapter filled. A harness that fails, for example because it has no login, gets its own error message in its row, and the next harness still runs. |
| `list`  | Lists the harnesses in default-preference order with their install state, and the cases.                                                                                                                                                                                                                                                   |

| Option                 | Commands                | Default                                         | Meaning                                                    |
| ---------------------- | ----------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `--a <subject>`        | `run`                   | `main`                                          | The baseline.                                              |
| `--b <subject>`        | `run`                   | the project                                     | The change.                                                |
| `--subject <subject>`  | `score`, `check`        | the project                                     | The subject to score or to probe.                          |
| `--harness <ids\|all>` | `run`, `score`, `check` | first installed (`run`, `score`), all (`check`) | Comma-separated harness ids.                               |
| `--case <glob>`        | `run`, `score`          | `*`                                             | Which case ids to run. Only `*` is special.                |
| `--cases <dir>`        | `run`, `score`, `list`  | `evals/cases` in the project                    | Where the cases are.                                       |
| `--reps <n>`           | `run`, `score`          | `3`                                             | Runs for each subject and case.                            |
| `--model <id>`         | `run`, `score`, `check` | the harness's own default                       | Passed to the harness unchanged.                           |
| `--min-score <0..1>`   | `run`, `score`          | no bar                                          | The lowest suite score that passes. See [Scores](#scores). |
| `--judge-harness <id>` | `run`, `score`          | the harness under test                          | The harness that scores judged checks.                     |
| `--judge-model <id>`   | `run`, `score`          | the value of `--model`                          | The model that scores judged checks.                       |
| `--out <dir>`          | `run`, `score`, `check` | a new temp directory                            | Where results go.                                          |

| Exit code | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| 0         | Every run is valid and every pass bar is reached.                                               |
| 1         | A run failed or is invalid, or a score is under its bar.                                        |
| 2         | A wrong command line, case file, config file, or subject. Also Windows, which is not supported. |

`run` and `score` print a Markdown report and the path of an output directory. Read the report first, then open the final answers of a case:

```text
<out>/results.json                          every run record, with check scores and judge reasons
<out>/<harness>/<case>/a1.final.md          final answer of subject A, repetition 1
<out>/<harness>/<case>/b1.final.md          final answer of subject B, repetition 1
<out>/<harness>/<case>/a1.stream.jsonl      the harness's raw event stream for that run
```

`score` names its files `subject1.final.md` and so on.

## What one run does

1. Creates a new, empty home directory and a new workspace directory. Their names (`home-*`, `proj-*`, `kit-*`) say nothing about why they exist.
2. Copies the case's `workspace/` folder into the workspace.
3. Copies the harness's credential files from your real home into the new home, so a login keeps working. Nothing else is copied.
4. Starts the harness with `HOME` and the XDG directories pointed at the new home, and with the subject loaded as [Subjects](#subjects) describes. The harness does not get the environment variables that name this tool: the ones that start with `SKILL_EVALS_` or `npm_`, and `_`.
5. Turns the harness's event stream into one run record and scores the case's checks. A judged check starts one more harness run, described under [Judged checks](#judged-checks).
6. Deletes both directories.

A run counts only when it is valid. A run is invalid when it failed (harness error, time limit), when the harness reported what it loaded and the subject was not in it, or when a judged check got no usable score. Invalid runs are listed under the table, left out of every number, and make the command exit 1.

"The subject was not in it" means that a plugin's directory is not among the loaded plugins, or that a skill of a skills folder is not among the listed skills. Only Claude Code reports either. In the other four harnesses a subject that did not load shows up as missing skill loads, not as an invalid run.

## Write a case

A case is a directory under `evals/cases/`. Its name is the case id.

| File         | Content                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt.md`  | The prompt, exactly as a user would type it. Nothing else.                                                                                             |
| `case.json`  | `{ "checks": [...], "weight": 1, "minScore": 0.5, "maxTurns": 6, "timeoutSeconds": 600 }`. Only `checks` is required, and it needs at least one check. |
| `workspace/` | Optional. Files the agent finds in its working directory.                                                                                              |

Every check takes an optional `weight`, a positive number that defaults to 1.

| Check                 | Fields                                                              | Scores 1 when                                                               |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `skill_loaded`        | `skill`                                                             | The agent loaded that skill.                                                |
| `skill_not_loaded`    | `skill`                                                             | The agent did not load it.                                                  |
| `output_contains`     | `text`                                                              | The final answer contains that text. The match is exact and case-sensitive. |
| `output_not_contains` | `text`                                                              | The final answer does not contain it.                                       |
| `output_matches`      | `pattern`, optional `flags`                                         | The final answer matches the regular expression.                            |
| `output_lacks`        | `pattern`, optional `flags`                                         | The final answer does not match it.                                         |
| `file_exists`         | `path`                                                              | That file exists in the workspace after the run.                            |
| `file_matches`        | `path`, `pattern`, optional `flags`                                 | That file exists and matches.                                               |
| `tool_called`         | `kind` or `name` or both, optional `inputMatches`, optional `flags` | The agent made a tool call that fits every given field.                     |
| `tool_not_called`     | the same                                                            | The agent made no such call.                                                |
| `judge`               | `rubric`                                                            | Not 0 or 1. A model scores the final answer against the rubric.             |

In every harness, "loaded a skill" means that the agent called the harness's skill tool with that skill's name, or that any tool call pointed at `skills/<name>/SKILL.md`.

`timeoutSeconds` defaults to 600. `maxTurns` has no default, and only Claude Code has a flag for it. The time limit alone bounds the other harnesses.

A prompt can start with any character. One that starts with a dash reaches the agent as the prompt and is not read as a flag of the harness.

The agent must not be able to tell that its answer is being measured. Write the prompt as a plain request, and keep these words out of the prompt and out of every file name under `workspace/`: `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, `arena`. Do not ask the agent which skills it used. The checks read that from its tool calls. The rubric stays in `case.json`, which the agent's workspace never holds. A plugin is loaded from where it is on disk, so the agent can see that path, and the cases too when they are inside the plugin's folder.

### Tool checks

`kind` says what the tool does, with the same word in every harness. Use it so that a case works in each harness.

| Kind       | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `shell`    | Ran a command.                                                       |
| `read`     | Read a file.                                                         |
| `write`    | Created or replaced a file.                                          |
| `edit`     | Changed part of a file, or deleted one.                              |
| `search`   | Searched or listed files.                                            |
| `web`      | Fetched a page or searched the web.                                  |
| `skill`    | Called the harness's skill tool.                                     |
| `subagent` | Started another agent.                                               |
| `other`    | Any tool the harness's adapter has no kind for, such as an MCP tool. |

`name` is a regular expression for the harness's own tool name, for example `^Bash$` in Claude Code. A check with `name` works in one harness only, so prefer `kind`. `inputMatches` is a regular expression for the call's input, written as JSON. `flags` applies to both expressions.

```json
{ "type": "tool_not_called", "kind": "shell", "inputMatches": "git push" }
```

Harnesses do not split work the same way. One harness has a search tool, and another runs `grep` through its shell tool, so `tool_called` with `"kind": "search"` can score 0 for an agent that did search. Tool calls that a subagent made count in the harnesses whose stream includes them (seen in Claude Code).

### Judged checks

A `judge` check asks a model how well the final answer meets the `rubric`, which is plain text that says what a good answer does. Use it for a quality that no pattern can find, such as whether a restatement keeps the meaning.

- The judge is one more harness run, so it works in each harness. It runs with nothing loaded, in a new home directory and an empty workspace, with a limit of two turns where the harness has a turn limit.
- The judge's prompt holds the case's prompt, the final answer, and the rubric. It does not hold the subject, the ref, a path, or the harness that produced the answer, so the judge cannot favor A or B.
- The judge must reply with one JSON object, `{"reason": "...", "score": 0.7}`. The scale is 0 for an answer that meets none of the rubric, 0.5 for about half, and 1 for all of it. A score outside 0 to 1 is rejected, not clamped.
- An unusable reply is asked for once more. After two unusable replies the check has no score and the run is invalid.
- `results.json` holds the judge's reason for each check, and the judge's duration, tokens, and cost for each run apart from the run's own.

A judge is a model, so its score moves. Measured with one small model as agent and judge on one case of the [magic](https://github.com/PhillipChaffee/magic) skills: six runs of an unchanged subject gave judged scores from 0.6 to 0.9, and four scorings of one fixed answer differed by 0.10 to 0.25. Use at least three reps, write a rubric with separate countable points, and name a stronger model with `--judge-model` when the differences you look for are small.

## Scores

Every score is a number from 0 to 1.

| Score       | What it is                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check score | What one check gave one run. A deterministic check gives 0 or 1. A judged check gives any value from 0 to 1.                                                  |
| Run score   | The weighted mean of the run's check scores. A check's `weight` defaults to 1. An invalid run has no score.                                                   |
| Case score  | The mean of the run scores of the valid runs, for one harness and one subject.                                                                                |
| Suite score | The weighted mean of the case scores, for one harness and one subject. A case's `weight` defaults to 1. A suite has no score while one of its cases has none. |

There are two pass bars. `--min-score` is the lowest suite score that passes. `minScore` in a `case.json` is the lowest score of that case that passes. Both apply to the subject under test, which is B for `run` and the one subject for `score`, in every harness that ran. A missing score does not reach a bar. The report ends with the bars that were not reached.

An example with two cases and `--reps 2`:

| Case          | Case weight | Checks                                        | Run 1                        | Run 2                        | Case score               |
| ------------- | ----------- | --------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------ |
| `plain-words` | 1           | `skill_loaded` (weight 1)                     | 1                            | 0                            | (1 + 0) / 2 = 0.50       |
| `explain`     | 2           | `judge` (weight 3), `output_lacks` (weight 1) | (3 × 0.8 + 1 × 1) / 4 = 0.85 | (3 × 0.6 + 1 × 0) / 4 = 0.45 | (0.85 + 0.45) / 2 = 0.65 |

The suite score is (1 × 0.50 + 2 × 0.65) / 3 = 0.60. With `--min-score 0.7` the command exits 1 and the report says that the suite score 0.60 does not reach 0.70.

### Read the report

The report has one section per harness and one row per case. `run` shows each value as `A / B (B - A)`. `score` shows one value.

- **Score** is the case score.
- **Checks** shows each check. A deterministic check shows how many valid runs passed it, for example `2/3`. A judged check shows its mean score, for example `0.67`.
- **Duration, input tokens, output tokens, cost** show the median over valid runs. Input tokens include cached tokens. `n/a` means the harness does not report that number.
- **Suite score** is under the table.
- **Judge** is one line under the suite score with the number of judge calls and their total duration, tokens, and cost. These are not part of the table's numbers.
- The first lines name each subject, the harness that ran, and why that harness was chosen.

One repetition tells you little. A check that passes 3 of 3 times on A and 1 of 3 on B is a signal. A check that passes 1 of 1 on A and 0 of 1 on B is not. Judged scores move between runs of the same subject, so read a difference in a judged check against that spread.

## Config file

An optional `skill-evals.config.json` in the project root sets defaults. A flag wins over the file.

```json
{
  "cases": "evals/cases",
  "harness": "claude-code",
  "reps": 3,
  "model": "<model-id>",
  "judgeHarness": "claude-code",
  "judgeModel": "<model-id>",
  "minScore": 0.8
}
```

Every key is optional and is the default of the flag with the same name. `cases` resolves against the project root. `harness` narrows `check` too. An unknown key, a value of the wrong type, or invalid JSON is an error with exit code 2.

## Use it from code

```js
import { evaluate, loadCases, HARNESSES } from "skill-evals";

const evaluation = await evaluate({
  cwd: "/path/to/project", // default: the working directory of the process
  subjects: ["none", "./skills"], // one subject to score, or two to compare (A, then B)
  model: "<model-id>",
  reps: 3,
  minScore: 0.8,
  onRun: (record) => console.error(record.caseId, record.score),
});
if (evaluation.belowBar.length || evaluation.invalid.length)
  process.exitCode = 1;
```

| Export                 | What it is                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate(options)`    | Does what `run` and `score` do, without the report. The options are `cwd`, `subjects`, `harness`, `cases`, `caseGlob`, `reps`, `model`, `judgeHarness`, `judgeModel`, `minScore`, `outDir`, and `onRun`. Unset options take their value from the config file. |
| `loadCases(dir, glob)` | Reads and validates the cases in a directory.                                                                                                                                                                                                                 |
| `HARNESSES`            | The harness adapters, in default-preference order.                                                                                                                                                                                                            |

`evaluate` resolves to `{ records, suites, belowBar, invalid, outDir, subjects, cases, harnesses, harnessReason, judge, reps, model }`. `suites` holds the case and suite scores for each harness, keyed by the subject's label (`a` and `b`, or `subject`). `belowBar` lists the pass bars that were not reached, and `invalid` lists the runs that do not count. The evaluation passed when both are empty. Everything but `cases` and `outDir` is also in `<outDir>/results.json`.

The package ships type declarations, so `evaluate`'s options and what it resolves to are typed in TypeScript.

`evaluate` prints nothing and does not end the process. A wrong option, case file, or config file rejects with an error whose `name` is `UsageError`. While it runs, SIGINT and SIGTERM end the process with exit code 130 after the temp directories, the worktrees, and the harness's processes are removed.

## Harnesses

`run` and `score` use the first installed harness in this order when you do not name one: `pi`, `claude-code`, `cursor`, `opencode`, `codex`. Pi leads because it has the smallest measured install (Pi 204 MB, OpenCode 412 MB, Codex 424 MB, Cursor 538 MB), starts in about a second, and reports tokens and cost.

| Harness       | Executable     | How a plugin is loaded                                                        | How the prompt is passed | Reports                                 |
| ------------- | -------------- | ----------------------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| `pi`          | `pi`           | `-e <dir>` with discovery switched off (`-ne -ns -np`)                        | on standard input        | tokens, cost                            |
| `claude-code` | `claude`       | `--plugin-dir <dir>`                                                          | after `--`               | tokens, cost, loaded plugins and skills |
| `cursor`      | `cursor-agent` | `--plugin-dir <dir>`                                                          | after `--`               | neither tokens nor cost                 |
| `opencode`    | `opencode`     | a `plugin` entry in the new home's `opencode.json`                            | after `--`               | tokens, cost                            |
| `codex`       | `codex`        | `codex plugin marketplace add <dir>` and `codex plugin add` into the new home | after `--`               | tokens                                  |

To use a different executable, set `SKILL_EVALS_BIN_<ID>` (for example `SKILL_EVALS_BIN_CLAUDE_CODE=/opt/bin/claude`). Use it when a version-manager shim needs your real home directory to find the binary.

### What was verified

`skill-evals check` is how you confirm an adapter on your own machine. These tables say what was confirmed when the adapters were written, and how. Only Claude Code ran a real model. "Scripted endpoint" means that the real CLI ran through this runner against a local model endpoint that replays a fixed tool call and a fixed answer, with every request it received logged.

Loading a plugin, confirmed in the [magic](https://github.com/PhillipChaffee/magic) repository where this runner started, and run again from this package on 2026-11-21:

| Harness       | Version          | Confirmed                                                                                                                                                                                                                      | Not confirmed                                                                                                                                                                                                                                            |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | 2.1.329, 2.1.330 | Real runs with a real model: `check`, `run` with a git ref, and `score`. A globally installed copy of the plugin did not load. The parser fixture is a captured stream.                                                        | A subscription login. The machine used authenticates through environment variables.                                                                                                                                                                      |
| `pi`          | 0.73.1           | Scripted endpoint: the command line is accepted, the plugin's extension and skills load from the directory, a decoy skill planted in the real home stays out, and the stream parses. The parser fixtures are captured streams. | A run with a real model. Cost for a priced model (the scripted model has no price).                                                                                                                                                                      |
| `opencode`    | 1.19.6           | Scripted endpoint: the plugin loads from the config entry, its skills are listed from the directory, a decoy skill stays out, and a native `skill` call parses.                                                                | A run with a real model. OpenCode V2, which reads the `plugins` key.                                                                                                                                                                                     |
| `codex`       | 0.171.0          | Scripted endpoint: both install commands succeed in the new home, the plugin's skills are listed from the plugin cache, a decoy skill stays out, and a command that reads a `SKILL.md` parses.                                 | A run with a real model.                                                                                                                                                                                                                                 |
| `cursor`      | 2026.11.19       | The CLI accepts the adapter's command line and stops at its login check. `check` reports that as a failed row and goes on.                                                                                                     | Everything after login. The parser and its fixture come from Cursor's [output format reference](https://cursor.com/docs/cli/reference/output-format), not from a captured run. Whether `--plugin-dir` loads the plugin's skills and hooks in print mode. |

Loading a skills folder, the `none` baseline, and a prompt that starts with a dash, confirmed on 2026-11-21:

| Harness       | Version    | Skills folder                                                                                                                                                                                                                                                                                       | Prompt that starts with a dash                                                                                                                     | Not confirmed                                                                |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `claude-code` | 2.1.330    | Real runs with a real model: `run --a none --b <folder>` gave 0 of 2 skill loads without the folder and 2 of 2 with it. The harness listed the skill at startup, so a folder that does not load makes the run invalid. A skill of the same name in the real home's `~/.claude/skills` did not load. | A real run: after `--` the prompt reached the model. Without `--` the CLI rejects it as an unknown option.                                         | A skill whose front matter `name` differs from its folder.                   |
| `pi`          | 0.73.1     | Scripted endpoint: the copy named with `--skill` is in the model request with discovery off, and decoy skills in the real home's `~/.pi/agent/skills` and `~/.agents/skills` are not.                                                                                                               | Scripted endpoint: the prompt on standard input is the user message, unchanged. Pi has no `--` separator and rejects such a prompt as an argument. | A run with a real model.                                                     |
| `opencode`    | 1.19.6     | Scripted endpoint: the copy in `~/.agents/skills` is in the model request, and the decoys are not.                                                                                                                                                                                                  | Scripted endpoint: after `--` the prompt is the user message. Without `--` the CLI prints its help.                                                | A run with a real model.                                                     |
| `codex`       | 0.171.0    | Scripted endpoint: the model request lists `~/.agents/skills` of the new home as a skill root with the copy in it, and the decoys are not there.                                                                                                                                                    | Scripted endpoint: after `--` the prompt is the user message. Without `--` the CLI rejects it.                                                     | A run with a real model.                                                     |
| `cursor`      | 2026.11.19 | The installed bundle's code has `.cursor/skills` under the home directory as a place it reads skills from. No run confirmed it.                                                                                                                                                                     | After `--` the CLI gets past its option parser and stops at its login check. Without `--` it rejects the prompt.                                   | Everything after login, so whether the skill and the prompt reach the model. |

With `none`, the scripted requests of Pi, OpenCode, and Codex held neither the subject's skill nor a decoy.

Tool kinds and the judge:

| Harness       | Tool kinds                                                                                                                                                                                                                                                        | Judge run with nothing loaded                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `Skill`, `Bash`, `Read`, `Edit`, `Write`, `WebFetch`, and `Agent` come from a captured run, which is a parser fixture. `Grep`, `Glob`, `WebSearch`, `NotebookEdit`, and `Task` are mapped but were not seen in a stream. Version 2.1.330 searched through `Bash`. | Real runs.                                                                                                        |
| `pi`          | The seven tool names come from the installed package (0.73.1). `read` was seen in a captured stream.                                                                                                                                                              | The same command line as the `none` baseline, which ran against the scripted endpoint. No judge reply was parsed. |
| `opencode`    | The names come from the installed binary (1.19.6). `skill` and `read` were seen in a stream.                                                                                                                                                                      | As for Pi.                                                                                                        |
| `codex`       | The item types come from the Codex source for `exec --json` events. `command_execution` was seen in a captured stream.                                                                                                                                            | As for Pi.                                                                                                        |
| `cursor`      | The names come from the installed bundle (2026.11.19). `read` and `write` are in the documented example stream. No run confirmed them.                                                                                                                            | Not run.                                                                                                          |

Two limits apply across harnesses. A login stored in the operating system's keychain may not follow the new home. If `check` reports a login error, set the harness's API key variable. Only Claude Code reports what it loaded, as [What one run does](#what-one-run-does) says.

### Add a harness

Adapters live in this package. Loading one from your own code is not supported yet.

1. Add `src/harnesses/<id>.ts` whose default export has the five fields of the `Harness` type in `src/harnesses/shared.ts`: `id`, `bin`, `authFiles`, `invocation`, `parse`. Declare the stream events that `parse` reads as a type in the same file.
2. In `invocation`, load a plugin subject the way the harness loads a local plugin (`pluginDir`), copy a skills subject to where the harness discovers a user's skills (`placeSkills`), and point the harness's own config variables into `home`. Return `setup` commands when the harness has to install the plugin before it runs. When `subject` is `null`, load nothing. The judge and the `none` baseline run that way.
3. Pass the prompt so that a leading dash cannot be read as a flag: after a `--` separator, or in `stdin` when the CLI has no separator. Confirm it against the real CLI.
4. In `parse`, normalize the stream and nothing more. Return `null` for a field the harness does not report. Put only a tool call's input in `toolCalls`, never its output, or file contents will count as skill loads. Build each tool call with `toolCall` and a table from the harness's tool names to the kinds under [Tool checks](#tool-checks).
5. Add the adapter to `HARNESSES` in `src/harnesses/index.ts` at its place in the preference order.
6. Capture one real stream into `test/fixtures/` and add it to `src/adapters.test.ts`. Add the harness to the table of skill locations in `src/invocation.test.ts`, and add a row to every table above.

## Develop

The sources are TypeScript in `src/`, with each test beside the code it covers. The lint, type, documentation, format, coverage, and hygiene gates come from the `typescript/` folder of [full-lint](https://github.com/PhillipChaffee/full-lint), whose README gives the reason for every rule.

```sh
npm ci
npm run format:check   # prettier
npm run typecheck      # tsc, strict and eight more flags
npm run lint           # eslint: typed rules, doc comments, size and complexity limits
npm test               # vitest; fails under 95% coverage of lines, functions, branches, or statements
npm run knip           # unused files, exports, and dependencies
npm run lint:lockfile  # every package comes from the npm registry over HTTPS
npm run lint:graph     # no import cycles, no orphan modules
npm run build          # compiles src/ to dist/, which is what the package ships
./run-gates.sh         # all of the above but the build, and the hygiene tools that CI installs
```

The tests run this package's code in the test process and start a stand-in harness from `test/fixtures/` as a real child process. One test packs the package, installs the tarball into an empty project, and runs it there.

`npm pack` and `npm publish` build first, so the tarball always holds a fresh `dist/`.

## License

MIT
