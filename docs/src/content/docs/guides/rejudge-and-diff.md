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

The files are copied after the agent exits and before the checks run, so nothing a `command` check writes is in the archive, and a check that is scored again starts from the files it started from. The archive is `<run>.workspace.tar` in the output directory, for example `claude-code/restate/subject1.workspace.tar`. It holds four top-level directories, with fixed names:

| Name         | Holds                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `workspace/` | The workspace as the agent and the commands left it.                                           |
| `seed/`      | The workspace as the agent started from it.                                                    |
| `remotes/`   | The run's bare remotes and linked worktrees. It is there only when the run had that directory. |
| `home/`      | The run's throwaway home, without the harness's login files.                                   |

The archive also holds `home-seed.json`, the hashes of the home as the prompt found it, which `rejudge` needs to tell what the agent changed. The harness's login files are never in the archive, and neither is a copy of one, wherever the agent put it: a file with the same size and content as a login file of at least 32 bytes is left out, and `workspaceArchive.omitted` lists it, which `rejudge` warns about. Shorter logins are not matched by content, because an empty or `{}` file is an ordinary file too; a link in the home is archived as a link and is never followed. The grader's copy of your `grader/` directory is never in it. A system without `tar` on `PATH` gets a usage error from this flag, and from nothing else. `results.json` names each archive in the record's `workspaceArchive`, as `{ "path": ..., "bytes": ... }`, or `null`.

Archives stay in the output directory. Delete them when you no longer need them: a workspace can be large.

## Re-judge a directory

```text
skill-evals rejudge results --cases evals/cases
```

`rejudge` reads the output directory `results` under its lock and scores every run again against the cases in `--cases` as they are now. It never starts the agent's harness. A judge harness starts only for a judged check that the judge cache does not answer.

- It leaves `results.json` and `results.jsonl` untouched. By default it writes `results.rejudged.json` beside them and prints the Markdown report.
- `--out <other dir>` writes the full set into that directory instead: `results.json`, `summary.json` and the reports. It is a report, not something you can resume: its records still point at the transcripts and archives of the directory you re-judged. `--out` equal to that directory, or to a directory that already holds `results.json` or `results.jsonl`, is a usage error, and the directory is locked while it is written.
- `--case <globs>` limits which cases are scored again; the others keep their records.
- `--judge-model`, `--judge-api` and `--judge-harness` choose who judges. The default is the way the earlier command judged: `results.json` records it in `meta.judge` (the API or a harness, which harness, and which model; results without it say it in `judge`, which `rejudge` reads). A flag that changes it warns once, because the cache answers only the same judge. The judge cache is the `judge-cache.jsonl` of the directory, scoped to each run, so an unchanged rubric costs nothing; decision answers are cached in it too. It is a cache, so `rejudge` may add lines to that file in the directory it reads. The API's base URL is not recorded: set `judgeUrl` in the config when it is not the provider's own.
- The exit code follows the [exit codes](../reference/exit-codes.md), applied to the new results. A run that the earlier command stopped before its judged checks (`skippedGraders`) is finished: it gets its scores, and a command that stopped only for that reason is no longer partial.

`--lenient` and `--isolated` default to what the earlier command used (`meta.lenient`, `meta.isolated`), the cases are loaded that way too, and `--lenient` is accepted. The decision model is the one the earlier command recorded, else the config's. `--out` may not be inside the directory you re-judge. Results written by 0.0.1 have no `meta` and are refused with "score again".

Only the checks change. A harness error, an isolation breach, a subject that did not load and a changed subject directory stay as the earlier command recorded them.

### What is not re-scored

`rejudge` tells you on standard error what it did not score again, and keeps those runs as they were:

- `not re-scored: the case changed beyond its checks`. Each new record has an `inputHash`: the sha256 of what the agent saw, which is the prompt, `workspace/`, the shared fixtures, `fixture/`, `home/`, the setup steps, the harness, the model, `maxTurns` and the names of the case's `env`. The checks, the rubrics and `grader/` are not in it. A record whose hash differs from the case's now would score an answer to another question, so it is not scored again. A record from before `inputHash` existed has none: it is scored again, with one warning.
- A case that is no longer in the cases directory, or no longer applies to the harness, keeps its records and is listed.
- A run without a workspace archive. A check that needs the workspace or the home (a file check, a `command` check, or a judged check that sees `files`) keeps its old score, matched by description, and is listed as `not re-scored: no workspace archive`. A check that is new to the case, or rewritten so that its description changed, counts as new: it needs them and has no score, so the run is invalid and the exit code is 3. Run again with `--keep-workspaces` to avoid this.
- A run whose transcript file or archive cannot be read.

A case with any run whose `inputHash` changed keeps all its runs. A record whose `transcriptFile` or archive path leaves the output directory is not followed.

## Compare two results

```text
skill-evals diff before after
```

`a` and `b` are output directories or `results.json` paths. The report has, for each case, the score change with the valid and planned runs on each side; the checks that started or stopped passing; and the change in cost and duration. It compares every subject label that both results have, one section each; a label that only one side has is a warning. When they share no label it compares the last subject of each, with a warning.

A check passes for a case when its mean score over the valid runs is at least 0.5. Checks match by description; checks that share a description match by position. The report lists only checks that exist on both sides.

A warning block comes first when the two results are not a fair pair: the models (`meta.models`), the harnesses, the tool version or any case hash differ, or a side has no `meta`. The block lists the cases whose hash differs. `diff` informs and exits 0. `--strict` turns any warning into exit 2, for a script that must refuse an unfair comparison.

```text
skill-evals diff before after --strict
```
