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

There are two pass bars. `--min-score` is the lowest suite score that passes. `minScore` in a `case.json` is the lowest score of that case that passes. Both apply to the subject under test, which is B for `run` and the one subject for `score`, in every harness that ran. A missing score does not reach a bar. The report ends with the bars that were not reached. [Use it in CI](ci.md) lists the exit codes.

## An example

An example with two cases and `--reps 2`:

| Case          | Case weight | Checks                                        | Run 1                        | Run 2                        | Case score               |
| ------------- | ----------- | --------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------ |
| `plain-words` | 1           | `skill_loaded` (weight 1)                     | 1                            | 0                            | (1 + 0) / 2 = 0.50       |
| `explain`     | 2           | `judge` (weight 3), `output_lacks` (weight 1) | (3 × 0.8 + 1 × 1) / 4 = 0.85 | (3 × 0.6 + 1 × 0) / 4 = 0.45 | (0.85 + 0.45) / 2 = 0.65 |

The suite score is (1 × 0.50 + 2 × 0.65) / 3 = 0.60. With `--min-score 0.7` the command exits 1 and the report says that the suite score 0.60 does not reach 0.70.
