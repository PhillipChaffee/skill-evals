# skill-evals

Know what your skills actually do. `skill-evals` runs your skills across the scenarios you care about, in a real coding agent, and scores each run from 0 to 1 against what you defined as success.

A language model does not do the same thing twice, so reading a skill tells you what you wrote and not what the agent will do with it. An eval is how you find out:

- **Understand.** Run each scenario several times and see what the agent does, and how often. It may never load the skill, load it and do the same as before, or load it for requests that have nothing to do with it.
- **Define success.** Write down what a good result is for each scenario. That turns "it seems better" into a benchmark you can score against.
- **Change with evidence.** Edit the skill, run the same scenarios again, and compare the scores before you merge.

This is a report for one `commit-message` skill, in Claude Code, with three runs for each side. A is no skills and B is the folder that holds the skill.

| Case               | Score, A / B (B - A) | What moved                                                                                          |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------- |
| `staged-diff`      | 0.33 / 1.00 (+0.67)  | The skill loaded in 0 of 3 runs on A and 3 of 3 on B. A typed subject line: 0 of 3, then 3 of 3.    |
| `described-change` | 0.26 / 0.11 (-0.15)  | The skill loaded in 0 of 3 runs on B.                                                               |
| `git-question`     | 1.00 / 1.00 (+0.00)  | A question that is not about writing a commit message. The skill stayed out in 3 of 3 runs on both. |

Suite score: 0.37 / 0.60 (+0.23)

The numbers are from a real run. The table is shortened: the report that the command prints shows every check of a case with its own pass count, and the duration, tokens, and cost of each case. The second row is the finding. The skill works when the agent loads it, and the agent does not load it when a change is only described.

## Before you run it

> [!WARNING]
> Every run is unattended and has full permissions in its harness. The agent can run commands and write files on your machine without asking, so only run prompts you wrote or read.

`skill-evals` needs Node 22 or later and at least one of the five harnesses installed. It has no dependencies. It runs on macOS and Linux. Windows is not supported.

## Install

```sh
npm install --save-dev skill-evals   # or run it without installing: npx skill-evals <command>
```

## Quick start

Run this in the folder that holds your skills. Replace `greet` with the name of one of your skills, and the prompt with a request that should make the agent use it.

```sh
mkdir -p evals/cases/greeting
echo 'Give me a greeting to start my day.' > evals/cases/greeting/prompt.md
echo '{ "checks": [{ "type": "skill_loaded", "skill": "greet" }] }' > evals/cases/greeting/case.json
npx skill-evals check                              # which harnesses work on this machine
npx skill-evals run --a none --model <model-id>    # A = no skills, B = your skills
```

The report shows how often the agent loaded the skill without your skills (0 of 3) and with them. [`examples/cases/hello`](examples/cases/hello) in the repository is one more case you can copy.

Each run starts in a new, empty home directory, so your own settings and default model are not there. Pass `--model`, or set `model` in the [config file](docs/src/content/docs/reference/config.md). Without it each harness uses its built-in default, which may be a provider you have no key for.

From here:

- `--a` and `--b` each take a directory, a git ref of the project, or `none`. The defaults compare `main` (A) with the project folder and its uncommitted changes (B). See [Subjects](docs/src/content/docs/concepts/subjects.md).
- `skill-evals score` scores one set of skills with no comparison.
- `--min-score 0.8` makes the command exit 1 when the suite score is under 0.8, so it can gate a pull request. See [Scores](docs/src/content/docs/guides/pass-bars.md).

## How it works

1. **You write a case.** A case is a folder under `evals/cases/` with a `prompt.md`, which holds the prompt exactly as a user would type it, and a `case.json`, which holds the checks. An optional `workspace/` folder holds files the agent finds in its working directory.
2. **Each case runs on both sides.** A run starts the harness in a new, empty home directory and a new workspace, with only the subject loaded: your skills, a plugin, or nothing. Your login is copied in. Your settings and the skills you installed globally are not. Each side runs three times unless you set `--reps`.
3. **Checks become scores.** Every check scores a run from 0 to 1. The checks of a run give a run score, the runs give a case score, and the cases give a suite score. Weights and pass bars are yours to set.

A run that failed or is invalid does not count. It is listed under the table and makes the command exit 1. [What one run does](docs/src/content/docs/concepts/one-run.md) has every step.

## Three kinds of check

**Deterministic.** Did the skill load? Was a tool called? Does a file exist, and does it match a pattern? The score is 0 or 1.

```json
{ "type": "skill_loaded", "skill": "commit-message" }
```

**Decision model.** You set the allowed answers and what each is worth. A decision model returns a probability for each answer, and the score is computed from the probabilities. No model writes the score.

```json
{
  "type": "decision",
  "question": "Does the answer avoid engineering jargon?",
  "expect": "yes"
}
```

**Judged.** A model scores the final answer against a rubric that you write in plain text. Use it for a quality that no pattern can find. A judge's score moves between runs, so use at least three reps.

```json
{
  "type": "judge",
  "rubric": "The restatement keeps the meaning of the original. It has at most three sentences."
}
```

[Checks](docs/src/content/docs/reference/checks.md) lists every check type and its fields.

## Harnesses

One case format works in all five.

| Harness     | Id            |
| ----------- | ------------- |
| Pi          | `pi`          |
| Claude Code | `claude-code` |
| Cursor      | `cursor`      |
| OpenCode    | `opencode`    |
| Codex       | `codex`       |

`run` and `score` use the first installed harness in that order. Name others with `--harness <ids|all>`. `skill-evals check` runs one small prompt in each installed harness and reports what worked.

The harnesses are not equally proven. Only Claude Code ran a real model while the adapters were written, and the Cursor adapter has not run past the login check. [What was verified](docs/src/content/docs/agents/verified.md) says what was confirmed for each one, and how.

## Documentation

The docs are a website, built from [`docs/`](docs/src/content/docs/index.md) and deployed with the landing page. The same pages read as Markdown here:

| Document                                                                                          | What it holds                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Quick start](docs/src/content/docs/quick-start.md) and [Safety](docs/src/content/docs/safety.md) | A first score, and what a run may do on your machine.                                                                                                                                                   |
| [Write a case](docs/src/content/docs/guides/write-a-case.md)                                      | The case format, tool checks, [judged checks](docs/src/content/docs/guides/judged-checks.md), and [decision checks](docs/src/content/docs/guides/decision-checks.md).                                   |
| [Read the report](docs/src/content/docs/guides/read-the-report.md)                                | The report, the output files, [pass bars](docs/src/content/docs/guides/pass-bars.md), and [CI](docs/src/content/docs/guides/ci.md).                                                                     |
| [Commands and flags](docs/src/content/docs/reference/commands.md)                                 | Generated from the code, like [Checks](docs/src/content/docs/reference/checks.md), the [config file](docs/src/content/docs/reference/config.md), and the [API](docs/src/content/docs/reference/api.md). |
| [Harnesses](docs/src/content/docs/agents/harnesses.md)                                            | The five harnesses, [what was verified](docs/src/content/docs/agents/verified.md) for each, and how to [add one](docs/src/content/docs/agents/add-a-harness.md).                                        |
| [Developing](docs/src/content/docs/project/developing.md)                                         | The gates, the website, and [releasing](docs/src/content/docs/project/releasing.md).                                                                                                                    |

## License

[MIT](LICENSE)
