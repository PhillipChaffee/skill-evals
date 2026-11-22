---
title: Set a pass bar
description: How scores are computed, and how to make the command fail under a score.
---

Every score is a number from 0 to 1.

| Score       | What it is                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check score | What one check gave one run. A deterministic check gives 0 or 1. A judged check or a decision check gives any value from 0 to 1.                              |
| Run score   | The weighted mean of the run's check scores. A check's `weight` defaults to 1. An invalid run has no score.                                                   |
| Case score  | The mean of the run scores of the valid runs, for one harness and one subject.                                                                                |
| Suite score | The weighted mean of the case scores, for one harness and one subject. A case's `weight` defaults to 1. A suite has no score while one of its cases has none. |

## Pass bars

There are four pass bars. `--min-score` is the lowest suite score that passes. `minScore` in a `case.json` is the lowest score of that case that passes. `--min-delta` is the least score difference, B minus A, that the suite must show. `minDelta` in a `case.json` is the same bar for that case. The score bars apply to the subject under test, which is B for `run` and the one subject for `score`, in every harness that ran. The delta bars apply to `run` only. A missing score, or a missing delta, does not reach a bar. The report ends with the bars that were not reached, and the command exits 1. [Use it in CI](ci.md) lists the exit codes.

A verdict is not a bar. The report says `helped`, `hurt` or `within noise` for each case and for the suite, and none of these changes the exit code. Only a bar does.

## Delta bars

A delta bar holds the _difference_ to a floor, not the score. It is on the point delta, B minus A, over the runs as they are, and not on the interval of the verdict. `--min-delta` takes a number from -1 to 1, and the config key `minDelta` sets its default. A negative bar lets B score lower by at most that much. The command line parser (`parseArgs`, not the shell) reads `-0.05` as a flag, so write it with an equals sign:

```sh
skill-evals run --a main --b . --min-delta 0.05
skill-evals run --a main --b . --min-delta=-0.05
```

```text
Below the pass bar:

- claude-code: suite delta +0.00 does not reach --min-delta +0.05
- claude-code: case `restate` delta +0.20 does not reach its minDelta +0.50
```

A case's `minDelta` is a key of its `case.json`:

```json
{
  "checks": [{ "type": "skill_loaded", "skill": "bro" }],
  "minDelta": 0.5
}
```

`--min-delta` with `score` is a usage error, because `score` has one subject and no difference to measure: `score` does not take the flag. A `minDelta` in the config file is ignored under `score`, and the report says so in the same note. A `minDelta` in a `case.json` that `score` runs is not checked, and the report says so once: `minDelta applies to run`. A case under its `minDelta` is a `failure` in the JUnit report, as a case under its `minScore` is.

## How many runs a verdict needs

A case is judged only when each side has at least 5 valid runs (`MIN_RUNS_FOR_VERDICT`); below that its verdict is `too few runs`, with the run count of each side. The suite delta needs at least 2 valid runs on each side of every case it covers. A percentile interval under-covers at small n, so the report does not widen it; it declines to judge instead. Bars and exit codes ignore the run count: a bar is on the point delta.

## Measure the noise first

A delta between two subjects is only worth a bar when it is larger than the delta that the same subject gives against itself. `calibrate` measures that. It runs one subject against itself, as `run` runs two, with 5 reps unless `--reps` or the config says otherwise, and writes `noise.json` beside `results.json`:

```sh
skill-evals calibrate --subject . --harness claude-code --out calibration
skill-evals run --a main --b . --noise calibration/noise.json
```

`calibrate` writes the other files that `run` writes as well. It applies no pass bar at all, neither `--min-score`, `--min-delta`, nor a case's `minScore` or `minDelta`: it measures, and holds nothing to a floor. It measures one harness, because noise differs between harnesses: more than one is a usage error. It writes no `noise.json` when no case has a valid run on both sides. `noise.json` holds:

```jsonc
{
  "schemaVersion": 1,
  // What was calibrated. The file is applied to this harness only, and a run at other reps,
  // or of a suite that shares no case id, gets a note in the report.
  "harness": "claude-code",
  "reps": 5,
  "seed": 1,
  "caseIds": ["restate"],
  // For each case: the standard deviation of the run scores, pooled over the two sides,
  // |mean A - mean B| (for information), and the 95th percentile of |delta*| over that case's A/A bootstrap,
  // which is the bound a case's verdict uses.
  "perCase": {
    "restate": { "sd": 0.08, "maxAbsDelta": 0.05, "p95AbsDelta": 0.09 },
  },
  // For each check type: the standard deviation of a check's score over the reps of one case, pooled.
  "perCheckType": { "file_exists": { "sd": 0.0 } },
  // The spread of the suite delta over the A/A bootstrap, and the 95th percentile of its absolute value.
  "suite": { "sd": 0.03, "p95AbsDelta": 0.06 },
}
```

`--noise <file>`, or `noise` in the config file (relative to the project root), makes a verdict use it: a delta no larger than the `p95AbsDelta` of its case, or of the suite, reads `within noise`, whatever its interval. The file applies to its own `harness` only: for another harness it is not applied, and the report says so. A case that the file does not list is judged by its interval alone, and the report says so. The file is read strictly: a file that is not JSON, has another `schemaVersion`, lacks a key (a file without `harness`, `reps`, `seed` or `caseIds` is refused, naming them), has an unknown key, or holds a number outside 0 to 1 is a usage error that names the file and the field.

The intervals come from a bootstrap that a seed makes reproducible. `--seed <n>` (config key `seed`) is a positive integer up to 4294967295 and defaults to 1; the same runs and the same seed give the same report, byte for byte, and `results.json` records the seed.

## An example

An example with two cases and `--reps 2`:

| Case          | Case weight | Checks                                        | Run 1                        | Run 2                        | Case score               |
| ------------- | ----------- | --------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------ |
| `plain-words` | 1           | `skill_loaded` (weight 1)                     | 1                            | 0                            | (1 + 0) / 2 = 0.50       |
| `explain`     | 2           | `judge` (weight 3), `output_lacks` (weight 1) | (3 × 0.8 + 1 × 1) / 4 = 0.85 | (3 × 0.6 + 1 × 0) / 4 = 0.45 | (0.85 + 0.45) / 2 = 0.65 |

The suite score is (1 × 0.50 + 2 × 0.65) / 3 = 0.60. With `--min-score 0.7` the command exits 1 and the report says that the suite score 0.60 does not reach 0.70.
