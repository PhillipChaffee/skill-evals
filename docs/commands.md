# Commands and reports

The commands and their options, what a subject is, what one run does, how scores are computed, and the config file. How to write a case is in [Cases and checks](cases-and-checks.md).

## Commands

| Command | What it does                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run`   | Runs every case against A and B, `--reps` times each, one run at a time, and scores both.                                                                                                                                                                                                                                                  |
| `score` | Runs every case against one subject and scores it.                                                                                                                                                                                                                                                                                         |
| `check` | Runs one small prompt in each installed harness. Reports whether the harness ran, whether it reported the subject as loaded, which skills the agent loaded, and which record fields the adapter filled. A harness that fails, for example because it has no login, gets its own error message in its row, and the next harness still runs. |
| `list`  | Lists the harnesses in default-preference order with their install state, and the cases.                                                                                                                                                                                                                                                   |

| Option                         | Commands                | Default                                         | Meaning                                                                                                     |
| ------------------------------ | ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--a <subject>`                | `run`                   | `main`                                          | The baseline.                                                                                               |
| `--b <subject>`                | `run`                   | the project                                     | The change.                                                                                                 |
| `--subject <subject>`          | `score`, `check`        | the project                                     | The subject to score or to probe.                                                                           |
| `--harness <ids\|all>`         | `run`, `score`, `check` | first installed (`run`, `score`), all (`check`) | Comma-separated harness ids.                                                                                |
| `--case <glob>`                | `run`, `score`          | `*`                                             | Which case ids to run. Only `*` is special.                                                                 |
| `--cases <dir>`                | `run`, `score`, `list`  | `evals/cases` in the project                    | Where the cases are.                                                                                        |
| `--reps <n>`                   | `run`, `score`          | `3`                                             | Runs for each subject and case.                                                                             |
| `--model <id>`                 | `run`, `score`, `check` | the harness's own default                       | Passed to the harness unchanged.                                                                            |
| `--min-score <0..1>`           | `run`, `score`          | no bar                                          | The lowest suite score that passes. See [Scores](#scores).                                                  |
| `--judge-harness <id>`         | `run`, `score`          | the harness under test                          | The harness that scores judged checks.                                                                      |
| `--judge-model <id>`           | `run`, `score`          | the value of `--model`                          | The model that scores judged checks.                                                                        |
| `--decision-model <id>`        | `run`, `score`          | none                                            | The decision model that scores decision checks. See [Decision checks](cases-and-checks.md#decision-checks). |
| `--decision-url <url>`         | `run`, `score`          | the provider's own                              | The base URL of the decision model's API.                                                                   |
| `--decision-timeout <seconds>` | `run`, `score`          | `60`                                            | How long one request to the decision model may take. A positive integer.                                    |
| `--out <dir>`                  | `run`, `score`, `check` | a new temp directory                            | Where results go.                                                                                           |

| Exit code | Meaning                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | Every run is valid and every pass bar is reached.                                                                                                      |
| 1         | A run failed or is invalid, or a score is under its bar.                                                                                               |
| 2         | A wrong command line, case file, config file, or subject. A decision check with no decision model or no API key. Also Windows, which is not supported. |

`run` and `score` print a Markdown report and the path of an output directory. Read the report first, then open the final answers of a case:

```text
<out>/results.json                          every run record, with check scores, judge reasons, and probabilities
<out>/<harness>/<case>/a1.final.md          final answer of subject A, repetition 1
<out>/<harness>/<case>/b1.final.md          final answer of subject B, repetition 1
<out>/<harness>/<case>/a1.stream.jsonl      the harness's raw event stream for that run
```

`score` names its files `subject1.final.md` and so on.

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

## What one run does

1. Creates a new, empty home directory and a new workspace directory. Their names (`home-*`, `proj-*`, `kit-*`) say nothing about why they exist.
2. Copies the case's `workspace/` folder into the workspace.
3. Copies the harness's credential files from your real home into the new home, so a login keeps working. Nothing else is copied.
4. Starts the harness with `HOME` and the XDG directories pointed at the new home, and with the subject loaded as [Subjects](#subjects) describes. The harness does not get the environment variables that name this tool: the ones that start with `SKILL_EVALS_` or `npm_`, and `_`. When the suite has a decision check, the harness does not get the decision model's API key either.
5. Turns the harness's event stream into one run record and scores the case's checks. A judged check starts one more harness run, described under [Judged checks](cases-and-checks.md#judged-checks). The decision checks of the case go to the decision model in one request, described under [Decision checks](cases-and-checks.md#decision-checks).
6. Deletes both directories.

A run counts only when it is valid. A run is invalid when it failed (harness error, time limit), when the harness reported what it loaded and the subject was not in it, or when a judged check or a decision check got no usable score. Invalid runs are listed under the table, left out of every number, and make the command exit 1.

"The subject was not in it" means that a plugin's directory is not among the loaded plugins, or that a skill of a skills folder is not among the listed skills. Only Claude Code reports either. In the other four harnesses a subject that did not load shows up as missing skill loads, not as an invalid run.

## Scores

Every score is a number from 0 to 1.

| Score       | What it is                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check score | What one check gave one run. A deterministic check gives 0 or 1. A judged check or a decision check gives any value from 0 to 1.                              |
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
- **Checks** shows each check. A deterministic check shows how many valid runs passed it, for example `2/3`. A judged check or a decision check shows its mean score, for example `0.67`. A decision check starts with the word `decision` and ends with the answer it expects or its options.
- **Duration, input tokens, output tokens, cost** show the median over valid runs. Input tokens include cached tokens. `n/a` means the harness does not report that number.
- **Suite score** is under the table.
- **Judge** is one line under the suite score with the number of judge calls and their total duration, tokens, and cost. These are not part of the table's numbers.
- **Decision model** is one more line of the same kind, with the number of requests to the decision model and their total duration and tokens.
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
  "decisionModel": "<decision-model-id>",
  "decisionUrl": "<base-url>",
  "decisionTimeout": 60,
  "minScore": 0.8
}
```

Every key is optional and is the default of the flag with the same name. `cases` resolves against the project root. `harness` narrows `check` too. An unknown key, a value of the wrong type, or invalid JSON is an error with exit code 2.
