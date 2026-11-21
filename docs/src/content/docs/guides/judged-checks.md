---
title: Judged checks
description: How a judge check is scored, and how much its score moves between runs.
---

A `judge` check asks a model how well the final answer meets the `rubric`, which is plain text that says what a good answer does. Use it for a quality that no pattern can find, such as whether a restatement keeps the meaning.

- The judge is one more harness run, so it works in each harness. It runs with nothing loaded, in a new home directory and an empty workspace, with a limit of two turns where the harness has a turn limit.
- The judge's prompt holds the case's prompt, the final answer, and the rubric. It does not hold the subject, the ref, a path, or the harness that produced the answer, so the judge cannot favor A or B.
- The judge must reply with one JSON object, `{"reason": "...", "score": 0.7}`. The scale is 0 for an answer that meets none of the rubric, 0.5 for about half, and 1 for all of it. A score outside 0 to 1 is rejected, not clamped.
- An unusable reply is asked for once more. After two unusable replies the check has no score and the run is invalid.
- `results.json` holds the judge's reason for each check, and the judge's duration, tokens, and cost for each run apart from the run's own.

A judge is a model, so its score moves. Measured with one small model as agent and judge on one case of the [magic](https://github.com/PhillipChaffee/magic) skills: six runs of an unchanged subject gave judged scores from 0.6 to 0.9, and four scorings of one fixed answer differed by 0.10 to 0.25. Use at least three reps, write a rubric with separate countable points, and name a stronger model with `--judge-model` when the differences you look for are small.
