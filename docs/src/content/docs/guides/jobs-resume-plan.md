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
- `results.json` lists the records in plan order: for each harness, each case, each repetition, each subject. The order does not depend on which run ended first. `results.jsonl` and the progress lines on standard error follow the order the runs end in.
- Parallel runs share your rate limits. If the harness answers with rate limit errors, lower `--jobs`.

## The files of an output directory

| File                | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `results.jsonl`     | One line for each finished run, added as the run ends: the run record, with `key` (what names the run's question) and `attempt` (always 1). It is what `--resume` reads.                                                                                                                                                                                                                                                                                                                                      |
| `results.json`      | The whole results. It is written when the command starts (with the reused runs), then at most every 10 seconds, and once at the end, through `results.json.tmp` and a rename, so it is always whole. While the command runs it has `"partial": { "reason": "running" }`; the last write has `"partial": null`.                                                                                                                                                                                                |
| `judge-cache.jsonl` | The judge's answers. See [Judged checks](judged-checks.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `.lock`             | `{pid, hostname, bootId, startTime}` of the command that writes the directory. On the same host and boot, the holder is live only while its process exists and started when the lock says; a lock left by a dead process, or by a killed container whose pid another process now has, is taken over with a warning. A lock from another host or boot is refused with a message that names `.lock`, the host and the pid: remove it if no command is using the directory. It is removed when the command ends. |

Each line of `results.jsonl` is written with one call from the main process, so lines never mix, even with `--jobs 8`. If the command is stopped in the middle of a write, only the last line can be cut short.

`--dry-run` and `plan --out` read the directory too; `--dry-run` raises the same usage errors as the command, and `plan --out <dir>` names the directory to read it. A fresh command does not overwrite earlier runs. When `<out>/results.jsonl` has a line, `--out <dir>` without `--resume` is a usage error: `<dir> holds N runs of an earlier command; pass --resume <dir>, remove results.jsonl, or choose another --out`.

## Continue a command that stopped

`--resume <dir>` continues the command whose output directory is `<dir>`. It implies `--out <dir>`. Pass the same options as the first command:

```text
skill-evals score --jobs 8 --out results
# stopped by a crash, a closed laptop, or Ctrl-C
skill-evals score --jobs 8 --resume results
```

For each run of the plan, the command computes the run's key: a sha256 of

- the case: its resolved definition, every file of its directory, the shared fixtures it uses and its grader;
- the subject's revision: the content hash of the export the run copies, with `subjectExclude`, the cases directory and the output directory left out, for a directory and for a git ref alike; `none` for none;
- the harness and its executable (real path, size and modification time, so a self-update of the harness re-runs), the model and the repetition;
- the tool's version, which is the package version, so a rebuild with the same version shares keys;
- the names, and a hash of the values, of the variables that the config key `env` passes through;
- the scoring: the judge's harness, API, URL, fallbacks and model, the decision model and its URL, `--isolated` and `--lenient`.

The subject's label is not in the key. A stored run is matched by its key and the label of its subject, so renaming a label re-runs.

- A record is reused when it is valid and is the last line of `results.jsonl` for its harness, case, subject label and repetition. A run that was made again leaves the files of the older one overwritten, so an older record is not reused. The progress line says `(reused)`.
- Any other run is made and added to `results.jsonl`. Lines with invalid records are kept.
- A changed case file, a changed subject, a different model, an updated harness or a different judge model changes the key, so those runs repeat.
- Records in `results.jsonl` that the plan does not have, such as those of a case that `--case` now leaves out, stay in the file and are left out of `results.json`.
- A reused record keeps its `transcriptFile`. When a run repeats, it may overwrite the transcript file of the record it replaces.
- `--resume` turns the judge cache on. The cache is kept for each run: an answer is served only to the run that earned it (same key and subject label), so the reps of a case stay independent.
- `--resume` without `--model` warns once: the default model of the harness may have changed, and the key cannot tell.
- If the last line of `results.jsonl` is not a valid run record, it was cut short. The command drops it, prints one warning, and repeats that run. A bad line before the last is a usage error that names the line number.
- `--resume <dir>` and `--out <other>` together are a usage error, and so is a directory with no `results.jsonl`.

## See what a command would do

`plan` prints what `run` or `score` would make, and spends nothing. It takes every flag of `run` and `score`; with `--a` or `--b` it plans a run, else a score. It starts no harness process: it only looks for the harness on `PATH`. It writes nothing to the output directory. It exports each subject to a temp directory to key the runs, and it raises every usage error the command would, so a wrong ref or case file fails here.

```text
skill-evals plan --harness all --reps 3 --jobs 4
```

It prints the matrix of harnesses, cases, subjects and repetitions, the number of runs, and the cases that are not applicable. `--dry-run` on `run` and `score` prints the same and exits 0:

```text
skill-evals score --reps 3 --dry-run
```

When `--resume` or `--out` names a directory that holds an earlier command's `results.jsonl` or `results.json`, `plan` also prints an estimate. With `results.jsonl` it counts how many runs a resume would reuse (`R of N runs would be reused`) and estimates the remaining ones. The estimate uses the median of the earlier valid runs of each harness and case, the last one of each run; invalid and replaced lines are left out. It says how many of the remaining runs it covers for the cost and for the duration (`estimate covers K of M runs`). The duration is divided by `--jobs`.

```text
skill-evals plan --resume results --jobs 8
```
