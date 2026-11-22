---
title: Judged checks
description: How a judge check is scored, and how much its score moves between runs.
---

A `judge` check asks a model how well the work meets the `rubric`, which is plain text that says what a good answer does. Use it for a quality that no pattern can find, such as whether a restatement keeps the meaning. A judge is a model, so its score moves. Prefer a deterministic check when one can say the same thing, and keep judged checks to a minority of a case's weight: `validate` warns when `judge` and `decision` checks carry more than `maxJudgedWeightShare` (default 0.5) of it.

## What the judge sees

- By default the judge is one more harness run, so it works in each harness. [Judging over an API](#judging-over-an-api) skips the harness. It runs with nothing loaded, in a new home directory and an empty workspace, with a limit of two turns where the harness has a turn limit.
- With no `sees`, the judge's prompt holds the case's prompt, the final answer, and the rubric, exactly as in 0.0.1. It does not hold the subject, the ref, a path of the subject, or the harness that produced the answer, so the judge cannot favor A or B.
- `sees` is a list of `"final"`, `"transcript"` and `"files"`. The default is `["final"]`. Without `"final"` the answer is left out of the prompt.
- `"transcript"` adds a rendering of what the agent did: one line for each event, `[#4 t2 main] assistant tool_call: Bash {"command":"npm test"}`, with the event's position, its assistant turn, the agent that made it (`main` for the main thread), its role and type, and inputs as compact JSON. A tool output is the tool's own text. When the rendering is over `maxChars` (default 60,000) each tool output is cut to 400 characters first, then the oldest tool outputs are dropped, then the oldest events. A first line says what was left out, such as `[… 12 tool outputs omitted …]`, so the judge never grades a gap as if it were the whole run. The transcript shows the agent's tool inputs, which can name paths in its workspace.
- `"files"` needs a `files` list of paths or globs, resolved against the workspace after the run by the same rules as the file checks: a path that leaves the workspace or goes through a link out of it is not read, and a directory name means the files under it. Each file is cut to 20,000 characters. A binary file (a NUL byte in its first 8 KB) and an image are named in the prompt and not shown, with `not shown`; over the API an image is sent with the prompt instead. A glob that matches nothing is stated in the prompt, and the check still runs. Commands run after the judged checks, so a `command` check cannot change a file before the judge reads it.

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
- `votes` is an odd number, 1 by default. Each vote is its own judge call (a harness session, or one API request), so three votes cost three judge calls; under `--isolated` each keeps the isolation a judge session has. Binary takes the majority, and `0-1` takes the median. `results.json` gives the check a `ballots` list of every vote's `score` and `reason`, beside the `votes` count you set; it has no `ballots` when `votes` is 1.
- A vote with no usable answer after its two attempts is recorded with its reason and a null score, and is left out of the majority or the median. With an even number of usable binary votes a tie scores 0, and the reason says so. The check has no score, and the run is invalid, only when no vote gave a usable answer.

A full example, with a deterministic check beside it, is `examples/cases/judge-transcript`.

## Judging over an API

A harness session for the judge costs more than it needs to and adds noise: the harness's own system prompt, tools and settings reach the judge. With `judgeApi` set, the judge calls the model's API directly, starts no harness process, and sends only the prompt.

```json
{
  "judgeApi": "anthropic",
  "judgeModel": "claude-opus-5-5"
}
```

- `judgeApi` (`--judge-api`) is `"anthropic"`, the only kind today. `judgeUrl` (`--judge-url`) is the base URL, `https://api.anthropic.com` by default; the request is `POST {judgeUrl}/v1/messages`. The package calls it with Node's `fetch`, so it still has no dependencies.
- The key is read from the variable that `judgeKeyVar` names, `ANTHROPIC_API_KEY` by default. A suite with a judge check and no key stops with a usage error before any run starts. The request carries the key in the `x-api-key` header and sends no `thinking`, `temperature`, `top_p` or `top_k`.
- The model is `judgeModel`, and `claude-opus-5-5` when that is not set. The warning about a judge that is the model under test compares this model with the model under test as before.
- `--judge-harness` is ignored, with a one-line warning, when `judgeApi` is set.
- The agent under test never gets the key. The variable is withheld from the harness, unless it is one of that harness's own login variables (`ANTHROPIC_API_KEY` is Claude Code's): the agent already has it, because it needs it to run. To keep the judge's key apart from the agent's, name another variable in `judgeKeyVar`.
- `judgeTimeout` is the seconds one request may take, a positive integer, 120 by default. A timeout, HTTP 429, a 5xx and a network error each count as a failed attempt, and the judge tries once more, as for an unusable reply. HTTP 400, 401 and 403 give an unusable answer whose reason holds the first 200 characters of the API's message.
- `judgeFallbacks` is `true` by default: the request has the header `anthropic-beta: server-side-fallback-2026-07-01` and `"fallbacks": "default"` in its body, so the server falls back when the model refuses. Set it to `false` for a proxy that rejects them. A reply that stops with `refusal` is an unusable answer, and its reason names the refusal's category when the API gives one.
- Image files (png, jpeg, gif and webp, each up to 5 MB) that `files` names are sent as image blocks before the text. The prompt lists them as `attached as an image`. Any other image stays named and not shown.
- The usage of a call is its input tokens (input, cache reads and cache writes added up) and output tokens. `costUsd` is null: the package holds no price table, so the report leaves the judge's cost out.

## The judge cache

The judge keeps its usable answers in `judge-cache.jsonl` in the output directory, one JSON line for each: `{ "key", "score", "reason", "usage" }`. The key is a sha256 of the judge's prompt (which holds the rubric, the task, the answer and everything the check sees), the hash of each attached file, the judge's model, the scale, and the index of the vote. Each vote of a check has its own key, so votes stay independent.

- The file is read at the start of a command and appended to after each answer. Ask the same question again, in the same output directory (`--out`) or in the same command, and the answer comes from the file: no call is made, and the run's `judge` usage counts it as `cacheHits` beside `calls`. The report says `N cache hits`.
- It works for both the API and a harness. An unusable answer is never kept, so it is asked again.
- Two reps whose answers read the same share one judge call. That is the point of the cache, and it also means that reps do not measure how much the judge moves for one answer. Delete `judge-cache.jsonl`, or use a new `--out`, to ask again.
- The key holds the model the judge was asked for. When no model is set, the harness picks one, and the key does not know which. Name a model with `--judge-model` when you reuse an output directory after upgrading the harness.

## Reply, retries and records

- A reply is one JSON object. A `0-1` reply is `{"reason": "...", "score": 0.7}`; the scale is 0 for an answer that meets none of the rubric, 0.5 for about half, and 1 for all of it. A score outside 0 to 1 is rejected, not clamped.
- An unusable reply is asked for once more. After two unusable replies the vote has no score.
- `results.json` holds the judge's reason for each check, and the judge's duration, tokens, and cost for each run apart from the run's own, and `cacheHits` when the cache answered a vote.
- When the judge's model is the model under test, which includes both being unset, the command prints one warning to standard error: `skill-evals: warning: the judge is the model under test; set --judge-model or judgeModel`.

## How much a judge moves

Measured with one small model as agent and judge on one case of the [magic](https://github.com/PhillipChaffee/magic) skills, with a `0-1` score and the final answer only: six runs of an unchanged subject gave judged scores from 0.6 to 0.9, and four scorings of one fixed answer differed by 0.10 to 0.25. That is the spread `scale: "binary"`, a structured rubric, and `votes` are for. Use at least three reps, write a rubric with separate countable points, and name a stronger model with `--judge-model` when the differences you look for are small.
