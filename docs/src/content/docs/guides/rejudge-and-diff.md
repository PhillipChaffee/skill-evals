---
title: Re-judge stored runs and diff two results
description: Score stored runs again after you rewrite a check, without starting the agent, and compare two sets of results.
---

A run is expensive and a check is cheap. When you rewrite a pattern, a rubric or a command, you do not need the agent to answer again: its transcript and its files are already stored. `rejudge` scores the stored runs again against the cases as they are now. `diff` compares two sets of results and says what changed.

## Keep the files of a run

The transcript of every run is always stored. The files are stored only when you ask for them. With `--keep-workspaces` (config key `keepWorkspaces`), the command archives each run after its checks, with the system `tar`:

```text
skill-evals score --keep-workspaces --out results
```

The archive is `<run>.workspace.tar` in the output directory, for example `claude-code/restate/subject1.workspace.tar`. It holds four top-level directories, with fixed names:

| Name         | Holds                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `workspace/` | The workspace as the agent and the commands left it.                                           |
| `seed/`      | The workspace as the agent started from it.                                                    |
| `remotes/`   | The run's bare remotes and linked worktrees. It is there only when the run had that directory. |
| `home/`      | The run's throwaway home, without the harness's login files.                                   |

The archive also holds `home-seed.json`, the hashes of the home as the prompt found it, which `rejudge` needs to tell what the agent changed. The harness's login files are never in the archive, and the grader's copy of your `grader/` directory is never in it. A system without `tar` on `PATH` gets a usage error from this flag, and from nothing else. `results.json` names each archive in the record's `workspaceArchive`, as `{ "path": ..., "bytes": ... }`, or `null`.

Archives stay in the output directory. Delete them when you no longer need them: a workspace can be large.

## Re-judge a directory

```text
skill-evals rejudge results --cases evals/cases
```

`rejudge` reads the output directory `results` under its lock and scores every run again against the cases in `--cases` as they are now. It never starts the agent's harness. A judge harness starts only for a judged check that the judge cache does not answer.

- It leaves `results.json` and `results.jsonl` untouched. By default it writes `results.rejudged.json` beside them and prints the Markdown report.
- `--out <other dir>` writes the full set into that directory instead: `results.json`, `summary.json` and the reports. `--out` equal to the directory you re-judge is a usage error.
- `--case <globs>` limits which cases are scored again; the others keep their records.
- `--judge-model`, `--judge-api` and `--judge-harness` choose who judges. The default is the judge model of the earlier command, through a harness session. The judge cache is the `judge-cache.jsonl` of the directory, scoped to each run, so an unchanged rubric costs nothing. The cache key includes the judge path, so a command that judged through `--judge-api` hits the cache only when `--judge-api` is given again.
- The exit code follows the [exit codes](../reference/exit-codes.md), applied to the new results. A run that the earlier command stopped before its judged checks (`skippedGraders`) is finished: it gets its scores, and a command that stopped only for that reason is no longer partial.

Only the checks change. A harness error, an isolation breach, a subject that did not load and a changed subject directory stay as the earlier command recorded them.

### What is not re-scored

`rejudge` tells you on standard error what it did not score again, and keeps those runs as they were:

- `not re-scored: the case changed beyond its checks`. Each new record has an `inputHash`: the sha256 of what the agent saw, which is the prompt, `workspace/`, the shared fixtures, `fixture/`, `home/`, the setup steps, the harness, the model, `maxTurns` and the names of the case's `env`. The checks, the rubrics and `grader/` are not in it. A record whose hash differs from the case's now would score an answer to another question, so it is not scored again. A record from before `inputHash` existed has none: it is scored again, with one warning.
- A case that is no longer in the cases directory, or no longer applies to the harness, keeps its records and is listed.
- A run without a workspace archive. A check that needs the workspace or the home (a file check, a `command` check, or a judged check that sees `files`) keeps its old score, matched by description, and is listed as `not re-scored: no workspace archive`. A check that is new to the case and needs them has no score, so the run is invalid and the exit code is 3. Run again with `--keep-workspaces` to avoid this.
- A run whose transcript file or archive cannot be read.

An archive holds the workspace after the checks ran. A `command` check that changes the workspace therefore runs on what the earlier run of it left.

## Compare two results

```text
skill-evals diff before after
```

`a` and `b` are output directories or `results.json` paths. The report has, for each case, the score change with the valid and planned runs on each side; the checks that started or stopped passing; and the change in cost and duration. It compares the last subject of each side, the one under test.

A check passes for a case when its mean score over the valid runs is at least 0.5. Checks match by description; checks that share a description match by position. The report lists only checks that exist on both sides.

A warning block comes first when the two results are not a fair pair: the models (`meta.models`), the harnesses, the tool version or any case hash differ, or a side has no `meta`. The block lists the cases whose hash differs. `diff` informs and exits 0. `--strict` turns any warning into exit 2, for a script that must refuse an unfair comparison.

```text
skill-evals diff before after --strict
```
