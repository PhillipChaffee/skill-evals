---
title: Run in parallel, resume and plan
description: Run several runs at once, continue a command that stopped, and see what a command would do before it spends anything.
---

A large suite takes a long time and costs money. This page shows how to run several runs at once with `--jobs`, how to continue a command that stopped with `--resume`, and how to see what a command would do with `plan` before it starts.

## Run several runs at once

`--jobs <n>` lets `n` runs be in flight at once. The default is 1, and `jobs` in the [config file](../reference/config.md) sets another default. It must be a positive integer; anything else is a usage error. It applies to `run` and `score`.

```text
skill-evals score --jobs 8 --out results
```

- Each run has its own home directory, workspace and copy of the subject, so one run cannot see another.
- `results.json` lists the records in plan order: for each harness, each case, each repetition, each subject. The order does not depend on which run ended first.
- The progress lines on standard error are printed in the order the runs end, so they can be out of plan order.
- With `--jobs 1`, the output is the same as before, and one extra file is written (see below).
- Parallel runs share your rate limits. If the harness answers with rate limit errors, lower `--jobs`.

## The files of an output directory

| File                | Holds                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `results.jsonl`     | One line for each finished run, added as the run ends: the run record, with `key` (what names the run's question) and `attempt` (always 1). |
| `results.json`      | The whole results. It is rewritten after every run, through `results.json.tmp` and a rename, so it is always whole and always valid JSON.   |
| `judge-cache.jsonl` | The judge's answers. See [Judged checks](judged-checks.md).                                                                                 |

A fresh command starts `results.jsonl` empty, so a directory that you reuse holds the runs of the last command only. Each line is written with one call from the main process, so lines never mix, even with `--jobs 8`. If the command is stopped in the middle of a write, only the last line can be cut short.

## Continue a command that stopped

`--resume <dir>` continues the command whose output directory is `<dir>`. It implies `--out <dir>`. Pass the same options as the first command:

```text
skill-evals score --jobs 8 --out results
# stopped by a crash, a closed laptop, or Ctrl-C
skill-evals score --jobs 8 --resume results
```

For each run of the plan, the command computes the run's key: a sha256 of the case (its resolved definition, every file of its directory, the shared fixtures it uses and its grader), the subject's revision (the git tree hash for a ref, the content hash of the copy for a directory, `none` for none), the harness, the model, the repetition, the tool's version, and the scoring (the judge's harness, API and model, the decision model, `--isolated` and `--lenient`).

- A key that has a valid record in `results.jsonl` is not run again. The last valid line for the key is used. The progress line says `(reused)`.
- A key with no record, or only invalid records, is run and added to `results.jsonl`. A line that has an invalid record is kept, and a later valid line wins.
- A changed case file, a changed subject, a different model or a different judge model changes the key, so those runs repeat.
- Records in `results.jsonl` that the plan does not have, such as those of a case that `--case` now leaves out, stay in the file and are left out of `results.json`.
- A reused record keeps its `transcriptFile`. When a run repeats, it may overwrite the transcript file of the record it replaces.
- `--resume` turns the judge cache on, so a judged check that was already answered is not asked again.
- If the last line of `results.jsonl` is not valid JSON, it was cut short. The command drops it, prints one warning, and repeats that run. A bad line before the last is a usage error that names the line number.
- `--resume <dir>` and `--out <other>` together are a usage error, and so is a directory with no `results.jsonl`.

## See what a command would do

`plan` prints what `run` or `score` would make, and spends nothing. It takes the same options. It starts no harness process: it only looks for the harness on `PATH`. It writes nothing.

```text
skill-evals plan --harness all --reps 3 --jobs 4
```

It prints the matrix of harnesses, cases, subjects and repetitions, the number of runs, and the cases that are not applicable. `--dry-run` on `run` and `score` prints the same and exits 0:

```text
skill-evals score --reps 3 --dry-run
```

When `--resume` or `--out` names a directory that holds an earlier command's `results.jsonl` or `results.json`, `plan` also prints an estimate of the cost and the duration. The estimate uses the median of the earlier runs of each harness and case, so it covers only the planned runs that an earlier run of the same harness and case matches: it says `estimate covers K of N runs`. The duration is divided by `--jobs`. The estimate is for the whole plan, reused runs included.

```text
skill-evals plan --resume results --jobs 8
```
