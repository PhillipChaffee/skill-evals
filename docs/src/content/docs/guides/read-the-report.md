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
- **Trigger recall by target skill** is a table under the coverage table: recall on the development and the held-out prompts, their gap, and the false-trigger rate, each with its run count. See [Held-out prompts](held-out.md).

## Verdicts, flake and discrimination

A comparison adds a **Verdict** column, one **Flake** column, and, when one subject is `none`, a discrimination table. `score` shows no verdict, because it has one subject.

```text
| Case    | Score, A / B (B - A)                 | Verdict                           | Checks                  | Flake    |
| restate | 0.80 / 1.00 (+0.20) (A 3 of 3 ...)   | helped (+0.20, 95% +0.12..+0.28)  | `skill_loaded bro` ...  | A 0%, B 0% |

Suite delta: helped (+0.20, 95% +0.12..+0.28) over 1 case

> Verdicts: percentile bootstrap over run scores (valid runs only), 95% interval, 2000 resamples, seed 1, resampled within each case (stratified); the suite delta is the mean of the case deltas by weight over the cases scored on both subjects. A case needs at least 5 valid runs on each side (MIN_RUNS_FOR_VERDICT) and the suite the same in every case it covers; below that the verdict is "too few runs". Percentile intervals under-cover at small n, so an interval from few runs is narrower than its 95% says. A delta reads "within noise" when its interval holds 0 or it is no larger than the noise bound. No noise file was given, so the interval alone decides.
```

- **Verdict** is the delta, B minus A, with its 95% interval: `helped (+0.12, 95% −0.03..+0.27)`. The interval is a percentile bootstrap over the run scores of the valid runs, 2000 resamples, with a seeded generator. The suite delta is stratified: the runs are resampled within each case that has a valid run on both sides, and the suite delta is the mean of the case deltas by weight, the formula of the suite score. A verdict is `within noise` when the interval holds 0, or when the delta is no larger than the noise bound (a case's `p95AbsDelta`, the suite's `p95AbsDelta`, from `--noise`). Otherwise it is `helped` for a positive delta and `hurt` for a negative one. A case with no valid run on one side has no delta: the cell says `n/a`, with no verdict. A case with fewer than 5 valid runs on a side (`MIN_RUNS_FOR_VERDICT`) is `too few runs (A n=3, B n=3)`, and the suite needs the same in every case it covers (`too few runs (fewest on a side: n=1)`). The footnote says that percentile intervals under-cover at small n. With B `none`, the footnote adds that verdicts are B minus A, so `hurt` means A scored higher. The footnote under the tables states the method, the resamples, the seed, the stratification and the noise file, and names the cases that the noise file does not list.
- **Flake** is the share of valid reps that disagree with the majority outcome of that check, for each subject: `A 33%, B 0%`. A rep passes a check when its check score is at least 0.5. An even split is 50%. `n/a` means no valid run. When some planned runs are unscored the cell says how many it is over: `33% (of 2)`.
- **Discrimination** is only for a comparison where A or B is `none`; a guard case is left out. Each case gets the first label that fits: `non-discriminating` when the none arm scores at least 0.9 (`NON_DISCRIMINATING_FLOOR`: the case does not need the skill), `failing with the subject` when the subject scores below 0.5 (`FAILING_CEILING`), `discriminating` when the verdict, taken from none to the subject, is `helped`, else `no evidence`. The report prints both constants.

```text
### Discrimination

| Case   | None | Subject | Discrimination     |
| helped | 0.00 | 1.00    | discriminating     |
| easy   | 1.00 | 1.00    | non-discriminating |
```

In `report.json` each entry of `cases` gains `delta`, `low`, `high`, `verdict` and `discrimination`. They are the case's, so the entries for A and B hold the same values, and all are `null` for `score`. A new top-level `method` holds `interval`, `confidence`, `resamples`, `seed`, `stratified`, `noiseFile`, `discrimination` (the two thresholds, or `null`) and the `footnote` text; it is `null` for `score`. `report.html` has the verdict and flake as columns of its case table (and the verdict in its suite table), then the discrimination table and the footnote. `report.xml` changes only through the bars: a case under its `minDelta` is a `failure`.

```jsonc
{
  "harness": "claude-code",
  "subject": "b",
  "caseId": "restate",
  "score": 1,
  "validRuns": 3,
  "plannedRuns": 3,
  "delta": 0.2,
  "low": 0.12,
  "high": 0.28,
  "verdict": "helped",
  "discrimination": null,
  "status": "pass",
  "tolerated": false,
}
```

`results.json` records `seed`, `noiseFile` (the path, or `null`), `noiseMeta` (the file's `harness`, `reps` and `caseIds`), `minDelta` (or `null`), `minDeltaIgnored` and `comparison`: for each harness, `cases` (each with `id`, `guard`, `minDelta`, `n` (the valid runs on each side), the means `a` and `b`, `delta`, `low`, `high`, `verdict`, the `noise` bound used and `discrimination`) and `suite` (the same, and `cases`, how many cases it covers, and `fewest`, the fewest valid runs on a side in any of them). `comparison` is `null` for `score`.

Under the common-set score of several harnesses, the line says how many of those cases ran with checks skipped on some harness: `Common set (3 cases: a, b, c, 2 cases with skipped checks).`

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

`summary.json` is written with the last write of a command, however it ended, and after the reports, so that a report that cannot be written is an error that the summary says (exit 5): it ran to the end, a budget stopped it, a signal interrupted it, or a run failed. It is not written while the command runs, and not for a usage error. A command removes the `summary.json` and `report.*` of an earlier command in the same directory when it starts, so a file you find is this command's. A failure before the first run leaves a summary with `partial: "error"` and no suites. Each file that is written is named on standard error as `skill-evals: wrote <path>`. `exit` is the code that the command exits with.

```jsonc
{
  "schemaVersion": 1,
  "exit": 3,
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

`report.json` is `{ "schemaVersion": 1, "summary": <the object above>, "method": <the object described above, or null>, "cases": [...] }`. Each entry of `cases` is one case for one harness and subject:

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

`status` is `pass`; `below`, when the subject under test is under the case's `minScore`; `invalid`, when any run of the case is invalid, whatever the score, with `tolerated: true` when the case has a valid run and the invalid runs of the command are within `--max-invalid`; `not-applicable`; or `not-run`, when a run of the plan did not run. `invalid` wins over `below`.

In `report.xml`, a case below its bar is a `failure`, a case with no valid run, or with invalid runs above `--max-invalid`, an `error`, and a case that is not applicable, or did not run (`not run`), is `skipped`. A case whose invalid runs are tolerated is filed by its score, and `system-err` names the invalid runs. A case with a score has it and its run count in `system-out`. Each testsuite also has a testcase `suite score`, a `failure` when the suite is under `--min-score` (its message gives the score and the run count), and, when the subject directory changed, a `subject unchanged` testcase that is an `error`.

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
  "caseHashes": { "claude-code": { "restate": "<sha256>" } },
  "isolated": false,
}
```

`harnessVersions` is the first line of `<executable> --version`, read once for each harness that runs a case, and for the judge's harness when a judged check is selected and the judge is not the API. The reads go in parallel and the command waits for them; a harness that takes longer than 10 seconds has its process group killed and its version is `null`, as it is when the command fails. `caseHashes` is the hash that the run key uses, for each harness and case, so a check that a harness dropped with `ifUnsupported: "skip"` is not in it. `plan` and `--dry-run` start no harness and read none. `dirty` is `true` when the working tree has uncommitted changes under the subject's directory, `false` for a git ref or a clean tree, and `null` for `none` and for a directory outside git.

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
