---
title: Use it in CI
description: Exit codes, and what a run needs on a machine that is not yours.
---

`run` and `score` can gate a pull request: the exit code says whether the suite passed.

| Exit code | Meaning                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | Every run is valid and every pass bar is reached.                                                                                                      |
| 1         | A run failed or is invalid, a score is under its bar, or the subject directory changed while the command ran.                                          |
| 2         | A wrong command line, case file, config file, or subject. A decision check with no decision model or no API key. Also Windows, which is not supported. |
| 4         | The command stopped before the end because it reached `--max-cost` or `--max-duration`. `results.json` has `partial` set. It wins over exit code 1.    |
| 130       | SIGINT or SIGTERM ended the command. The results so far are written first.                                                                             |

- **Set the bar.** `--min-score 0.8` makes the command exit 1 when the suite score is under 0.8, and `minScore` in a `case.json` does the same for one case. See [Set a pass bar](pass-bars.md).
- **Isolate the run.** `--isolated` (or `"isolated": true` in the config file) starts the harness with nothing loaded but the subject, and checks the harness's own report of what it loaded. A run that reports a plugin, a prefixed skill or agent, or an MCP server that is not the subject's, such as a plugin that your organization installs on the runner, is invalid with the reason `loaded outside the subject: <names>`. A harness that should report what it loaded and does not makes the run invalid too. Use it in CI, where the machine's settings can change a score without a case change. It covers only what the report lists. It does not prove that managed policy settings (hooks, environment, permissions), a managed `CLAUDE.md`, rules, hooks and managed agents are off. User level is the throwaway home plus anything the account syncs into it: synced skills and plugins are detected from the files they leave, and the `user` setting source also lets the organization's default model apply, so pass `--model` in CI; [Harnesses](../agents/harnesses.md) says what each harness covers and which harnesses take the flag (today Claude Code only).
- **Name the model.** Each run starts in a new, empty home directory, so no settings and no default model are there. Pass `--model`, or set `model` in the [config file](../reference/config.md). Without it each harness uses its built-in default, which may be a provider you have no key for.
- **Give the harness a login.** A run copies the harness's credential files into its new home. A login stored in the operating system's keychain may not follow. Run `skill-evals check` on the machine first, and if it reports a login error, set the harness's API key variable.
- **Keep the results.** `--out <dir>` sets where results go. The default is a new temp directory. [Read the report](read-the-report.md) says what the directory holds.
- **Review the prompts.** Every run is unattended and has full permissions in its harness, so only run prompts you wrote or read. See [Safety](../safety.md).

## Rate limits are shared across jobs

`--jobs <n>` keeps `n` runs in flight, and every run asks the same account and the same provider. The provider's rate limit is per account, not per job, so eight jobs spend a minute's allowance eight times as fast. Start with `--jobs 2`, and raise it only while runs stop failing with a rate limit. A rate-limited run is invalid with the harness's own error, so it shows in the `invalid` list of the report. `--retries` (below) tries it again after a wait.

## Set a budget

A suite that grows can spend more than you meant to. Two flags stop a command before that:

```sh
skill-evals run --a main --b . --reps 5 --jobs 4 --max-cost 20 --max-duration 90 --out results
```

- `--max-cost <usd>` (config key `maxCost`) takes a positive number. The command sums what its own attempts cost: the agent, the judge and the decision model. Runs that an earlier command made and `--resume` reused are not counted.
- `--max-duration <min>` (config key `maxDuration`) takes a positive number of minutes, counted from the start of the command, before the subjects are exported. Fractions are allowed: `--max-duration 0.5` is 30 seconds.

Both are checked before each run starts and before each retry. When the summed cost is at or above the limit, or the elapsed time is, no new run starts. The runs already in flight finish, but their judged checks and decision checks are not asked: those checks get no score with the reason `skipped: budget reached` (or `skipped: duration reached`). Command checks and the other checks of such a run still run. A run is also treated as in flight at the breach when its own agent cost, added to what the command has spent, reaches the limit before its judge starts. A run with a skipped check is invalid and its record has `skippedGraders: true`:

```text
{
  "caseId": "plain-words",
  "score": null,
  "skippedGraders": true,
  "checks": [
    { "type": "judge", "score": null, "reason": "skipped: budget reached" }
  ]
}
```

The command then writes `results.json` with `"partial": { "reason": "budget" }` (or `"duration"`) and `notRun`, the list of the runs that were never started or had their graders skipped (`{ "harness", "caseId", "subject", "rep" }` each). It prints the report, which has a "Stopped early" section: the limit, "K of N runs did not run; scores cover finished runs only" for each harness and subject, and a note when the two subjects of a comparison finished different numbers of runs. It exits 4. A stopped command did not succeed, whatever its scores say. Continue it with `--resume <dir>`; a run with `skippedGraders` is repeated in full, because only a valid record is reused. A later command, `rejudge`, will score such a run without repeating the agent, and will be the cheap way to finish it.

`--max-cost` is a usage error (exit 2, before any run) when it cannot count the whole command:

- a selected harness does not report its cost (today `codex` and `cursor`);
- the judge cannot report one: the judge API (`--judge-api`) reports no cost, and neither does a judge harness that reports none;
- a case has a decision check, which reports no cost.

`--max-duration` has no such condition. A harness that reports a cost can still return none for a run, for example a run that was stopped at its time limit. The same goes for a judge reply that states no cost: the budget sums replies one by one, so the others still count. The command warns once, `3 costs were not reported (agent attempts and judge replies); the budget counts only reported costs`, and counts only what was reported.

While a command runs, each line on standard error ends with its progress, `[n/N] $<spent> ETA <time>`:

```text
claude-code plain-words b1: score 0.86 [7/60] $1.2400 ETA 18:30
```

`n` counts finished runs, reused ones included, and `N` is the whole plan. `$<spent>` is what this command has spent, `≥$<spent>` when some cost was not reported, or `$?` until a cost has been reported. `ETA` is the runs left times the median wall time of the runs this command has finished, divided by `--jobs`, as `mm:ss` (`h:mm:ss` from one hour on). It reads `--:--` until a run has finished.

## Retry what the infrastructure broke

`--retries <n>` (config key `retries`, a non-negative integer, default 0) makes a run again, at most `n` more times, when it failed for a reason that is not the agent's:

| Reason                      | What it is                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| harness crash               | The harness exited non-zero, or died of a signal, and its stream has no final event. A start that failed with `EAGAIN`, `EMFILE` or `ENFILE` counts too. |
| rate limit                  | The adapter's `isRateLimit` says the run's error is one. A rate-limited run waits 30 seconds times the attempt number first.                             |
| timeout before first output | The time limit stopped a harness that had produced no agent event (a message or a tool call). Its opening `init` event does not count.                   |

A crash and a timeout are tried again at once. A setup failure, a precondition, a fault of the runner's own turn counter, a run that loaded outside the subject or did not load it (an isolation breach), any other invalid run, and a low score are never retried: they are about the case or the agent, and a second try would hide them.

The record of the last attempt is the run's record. Its `attempts` lists the error, the cost (`null` when none was reported) and the duration of each earlier attempt, and in `results.jsonl` its `attempt` is its own number. The file has the last attempt's line only:

```text
{
  "caseId": "plain-words",
  "score": 1,
  "error": null,
  "attempts": [{ "error": "no result event", "costUsd": null, "durationMs": 1840 }]
}
```

Every attempt is paid for: its cost counts against `--max-cost`, and a retry is not started once a limit is reached, before or after a rate-limit wait. The report has a "Retried runs" section with how many runs were retried and what the failed attempts took; their cost is not in the table.

The patterns that `isRateLimit` uses are in `src/harnesses/rate-limit.ts` and match provider-shaped text only: `429 Too Many Requests`, `status: 429`, `HTTP 429`, `rate_limit_error`, `overloaded_error`, `rate limit reached` or `exceeded`. A bare `429` does not match, because a stack position such as `cli.js:429:17` has one. Every adapter uses the same ones. They come from the providers' documented errors and are not verified against real runs of any harness, so check the first rate-limited run of yours: if its error is not retried, the pattern does not match its wording.

## Interrupts

SIGINT (Ctrl-C) and SIGTERM, which most CI systems send to cancel a job, end the command cleanly:

1. The process group of each harness that is running is killed. Nothing is recorded for them. A process that left the group with `setsid` can survive; the tool does not chase it.
2. `results.json` is written with the finished runs and `"partial": { "reason": "interrupted" }`.
3. The lock on the output directory is released.
4. The command exits 130.

A second signal while this runs exits 130 at once. Continue with `--resume <dir>`; the runs that were in flight start again.

## Resume in CI

Keep the output directory between jobs, as a cache or an artifact, and continue a stopped command with the same flags plus `--resume`:

```sh
skill-evals run --a main --b . --model sonnet --max-cost 20 --out results || [ $? -eq 4 ]
skill-evals run --a main --b . --model sonnet --resume results
```

Exit 4 means the command stopped on purpose and `results` holds what it did, so the first line accepts it and the second one finishes the suite. Pass the same `--model` both times, because a reused record is only as good as the model it ran with: `--resume` without `--model` warns. A reused run is not repeated and costs nothing, so a budget on the second command counts only the new runs. [Run in parallel, resume and plan](jobs-resume-plan.md) says what makes a record reusable.
