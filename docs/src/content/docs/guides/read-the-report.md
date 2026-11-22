---
title: Read the report
description: What the report shows, and where the answers behind it are.
---

The report has one section per harness and one row per case. `run` shows each value as `A / B (B - A)`. `score` shows one value.

- **Score** is the case score, with the runs behind it: `0.67 (2 of 3 runs)` says that two valid runs of the three planned gave this score. The count is beside every score in the report, so a score from one valid run is not mistaken for one from three. A comparison shows `0.33 / 1.00 (+0.67) (A 3 of 3 runs, B 2 of 3 runs)`.
- **Checks** shows each check. A deterministic check shows how many valid runs passed it, for example `2/3`. A judged check or a decision check shows its mean score and the runs behind it, for example `0.67 (3 of 3 runs)`. A decision check starts with the word `decision` and ends with the answer it expects or its options.
- **Duration, input tokens, output tokens, cost** show the median over valid runs. Input tokens include cached tokens. `n/a` means the harness does not report that number.
- **Suite score** is under the table: `Suite score: 0.80 (2 of 3 cases, 5 of 6 runs)` says that two of three cases apply to the harness and that 5 of its 6 planned runs are valid.
- **Judge** is one line under the suite score with the number of judge calls and their total duration, tokens, and cost. These are not part of the table's numbers.
- **Decision model** is one more line of the same kind, with the number of requests to the decision model and their total duration and tokens.
- The first lines name each subject, the harness that ran, and why that harness was chosen.

One repetition tells you little. A check that passes 3 of 3 times on A and 1 of 3 on B is a signal. A check that passes 1 of 1 on A and 0 of 1 on B is not. Judged scores move between runs of the same subject, so read a difference in a judged check against that spread.

## The summary and the report formats

`--report md|json|junit|html` chooses the formats. It is a list: repeat the flag or separate the formats with commas, and `report` in the [config file](../reference/config.md) sets the default, which is `md`. `md` goes to standard output, and only when it is listed. The others go to the output directory:

```sh
skill-evals score --subject ./skills --out results --report json,junit,html
```

```text
<out>/report.json    the summary and one entry for each case
<out>/report.xml     JUnit XML: one testsuite for each harness and subject, one testcase for each case
<out>/report.html    one file with inline style, tables only, no script and no external reference
<out>/summary.json   written by every command, whatever formats were asked for
```

`summary.json` is written with the last write of a command, however it ended: it ran to the end, a budget stopped it, a signal interrupted it, or a run failed. It is not written while the command runs, and not for a usage error. `exit` is the code that the command exits with.

```jsonc
{
  "schemaVersion": 1,
  "exit": 1,
  "suites": [
    {
      "harness": "claude-code",
      "label": "subject",
      "score": 0.75,
      "applicable": 3,
      "total": 4,
      "validRuns": 8,
      "plannedRuns": 9,
    },
  ],
  "belowBar": [
    "claude-code: suite score 0.75 (8 of 9 runs) does not reach --min-score 0.80",
  ],
  "invalid": 1,
  "notApplicable": 1,
  "partial": null,
  "costUsd": 0.42,
  "durationMs": 184000,
}
```

`label` is `subject`, or `a` and `b` for a comparison. `invalid` counts the finished runs that do not count; a run that never ran because a limit stopped the command is not in it. `partial` is `budget`, `duration`, `interrupted`, `error` or `null`. `costUsd` adds up every cost that was reported, the judge's, the decision model's and the failed attempts' included, and is `null` when none was. `durationMs` adds up the time of every run and failed attempt, so with `--jobs` it is longer than the wall time.

`report.json` is `{ "schemaVersion": 1, "summary": <the object above>, "cases": [...] }`. Each entry of `cases` is one case for one harness and subject:

```jsonc
{
  "harness": "claude-code",
  "subject": "subject",
  "caseId": "restate",
  "score": 0.67,
  "validRuns": 2,
  "plannedRuns": 3,
  "status": "invalid",
}
```

`status` is `pass`; `below`, when the subject under test is under the case's `minScore`; `invalid`, when any run of the case is invalid, whatever the score; `not-applicable`; or `not-run`, when a run of the plan did not run. `invalid` wins over `below`.

In `report.xml`, a case below its bar is a `failure`, a case with an invalid run an `error`, and a case that is not applicable, or did not run (`not run`), is `skipped`. A passing case has its score and run count in `system-out`.

## What `results.json` records about the command

`results.json` has `schemaVersion: 1` and `meta`, so that a number can be traced to the tools and files that made it:

```jsonc
{
  "toolVersion": "0.1.0",
  "harnessVersions": { "claude-code": "2.1.0 (Claude Code)", "pi": null },
  "models": { "agent": "<model-id>", "judge": null, "decision": null },
  "subjects": [
    { "label": "subject", "revision": "<content hash>", "dirty": true },
  ],
  "caseHashes": { "restate": "<sha256>" },
  "isolated": false,
}
```

`harnessVersions` is the first line of `<executable> --version`, read once for each harness the command may start, the judge's included, with a limit of 10 seconds; it is `null` when that fails. `plan` and `--dry-run` start no harness and read none. `dirty` is `true` when the working tree has uncommitted changes under the subject's directory, `false` for a git ref or a clean tree, and `null` for `none` and for a directory outside git.

## The output directory

`run` and `score` print a Markdown report and the path of an output directory. Read the report first, then open the final answers of a case:

```text
<out>/results.json                          every run record, with check scores, judge reasons, and probabilities
<out>/summary.json                          the exit code and the figures of the command, written at its end
<out>/results.jsonl                         one line for each finished run, added as it ends; what --resume reads
<out>/<harness>/<case>/a1.final.md          final answer of subject A, repetition 1
<out>/<harness>/<case>/b1.final.md          final answer of subject B, repetition 1
<out>/<harness>/<case>/a1.stream.jsonl      the harness's raw event stream for that run
```

`score` names its files `subject1.final.md` and so on.
