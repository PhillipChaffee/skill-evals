---
title: Judged checks
description: How a judge check is scored, and how much its score moves between runs.
---

A `judge` check asks a model how well the work meets the `rubric`, which is plain text that says what a good answer does. Use it for a quality that no pattern can find, such as whether a restatement keeps the meaning. A judge is a model, so its score moves. Prefer a deterministic check when one can say the same thing, and keep judged checks to a minority of a case's weight: `validate` warns when `judge` and `decision` checks carry more than `maxJudgedWeightShare` (default 0.5) of it.

## What the judge sees

- The judge is one more harness run, so it works in each harness. It runs with nothing loaded, in a new home directory and an empty workspace, with a limit of two turns where the harness has a turn limit.
- With no `sees`, the judge's prompt holds the case's prompt, the final answer, and the rubric, exactly as in 0.0.1. It does not hold the subject, the ref, a path of the subject, or the harness that produced the answer, so the judge cannot favor A or B.
- `sees` is a list of `"final"`, `"transcript"` and `"files"`. The default is `["final"]`. Without `"final"` the answer is left out of the prompt.
- `"transcript"` adds a rendering of what the agent did: one line for each event, `[#4 t2 main] assistant tool_call: Bash {"command":"npm test"}`, with the event's position, its assistant turn, the agent that made it (`main` for the main thread), its role and type, and inputs as compact JSON. A tool output is the tool's own text. When the rendering is over `maxChars` (default 60,000) each tool output is cut to 400 characters first, then the oldest tool outputs are dropped, then the oldest events. A first line says what was left out, such as `[… 12 tool outputs omitted …]`, so the judge never grades a gap as if it were the whole run. The transcript shows the agent's tool inputs, which can name paths in its workspace.
- `"files"` needs a `files` list of paths or globs, resolved against the workspace after the run by the same rules as the file checks: a path that leaves the workspace or goes through a link out of it is not read, and a directory name means the files under it. Each file is cut to 20,000 characters. A binary file (a NUL byte in its first 8 KB) and an image are named in the prompt and not shown, with `not shown`. A glob that matches nothing is stated in the prompt, and the check still runs. Commands run after the judged checks, so a `command` check cannot change a file before the judge reads it.

```json
{
  "type": "judge",
  "rubric": "The summary names the file that was changed and why.",
  "sees": ["transcript", "files"],
  "files": ["docs/summary.md"]
}
```

## Binary scores, a structured rubric, and votes

- `scale` is `"0-1"` (the default, which scores a 0.0.1 rubric as before) or `"binary"`. Use `binary`: a model is steadier at pass or fail than at 0.7 or 0.8. A binary judge replies `{"reason": "...", "verdict": "pass"}` or `"fail"`; a pass scores 1 and a fail scores 0.
- `rubric` is text, or `{ "pass": "...", "fail": "..." }`. The prompt then shows two sections, `Passes when:` and `Fails when:`. Writing what fails as well as what passes is the cheapest way to make a judge steadier.
- `votes` is an odd number, 1 by default. Each vote is its own judge call, with its own harness session, so three votes cost three judge runs; under `--isolated` each keeps the isolation a judge session has. Binary takes the majority, and `0-1` takes the median. `results.json` gives the check a `votes` list of every vote's `score` and `reason`; it has none when `votes` is 1.
- A vote with no usable answer after its two attempts is recorded with its reason and a null score, and is left out of the majority or the median. With an even number of usable binary votes a tie scores 0, and the reason says so. The check has no score, and the run is invalid, only when no vote gave a usable answer.

A full example, with a deterministic check beside it, is `examples/cases/judge-transcript`.

## Reply, retries and records

- A reply is one JSON object. A `0-1` reply is `{"reason": "...", "score": 0.7}`; the scale is 0 for an answer that meets none of the rubric, 0.5 for about half, and 1 for all of it. A score outside 0 to 1 is rejected, not clamped.
- An unusable reply is asked for once more. After two unusable replies the vote has no score.
- `results.json` holds the judge's reason for each check, and the judge's duration, tokens, and cost for each run apart from the run's own.
- When the judge's model is the model under test, which includes both being unset, the command prints one warning to standard error: `skill-evals: warning: the judge is the model under test; set --judge-model or judgeModel`.

## How much a judge moves

Measured with one small model as agent and judge on one case of the [magic](https://github.com/PhillipChaffee/magic) skills, with a `0-1` score and the final answer only: six runs of an unchanged subject gave judged scores from 0.6 to 0.9, and four scorings of one fixed answer differed by 0.10 to 0.25. That is the spread `scale: "binary"`, a structured rubric, and `votes` are for. Use at least three reps, write a rubric with separate countable points, and name a stronger model with `--judge-model` when the differences you look for are small.
