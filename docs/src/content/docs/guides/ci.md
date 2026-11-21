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

- **Set the bar.** `--min-score 0.8` makes the command exit 1 when the suite score is under 0.8, and `minScore` in a `case.json` does the same for one case. See [Set a pass bar](pass-bars.md).
- **Isolate the run.** `--isolated` (or `"isolated": true` in the config file) starts the harness with nothing loaded but the subject, and checks the harness's own report of what it loaded. A run that reports a plugin, a prefixed skill or agent, or an MCP server that is not the subject's, such as a plugin that your organization installs on the runner, is invalid with the reason `loaded outside the subject: <names>`. A harness that should report what it loaded and does not makes the run invalid too. Use it in CI, where the machine's settings can change a score without a case change. It covers only what the report lists. It does not prove that managed policy settings (hooks, environment, permissions), a managed `CLAUDE.md`, rules and hooks are off; [Harnesses](../agents/harnesses.md) says what each harness covers and which harnesses take the flag (today Claude Code only).
- **Name the model.** Each run starts in a new, empty home directory, so no settings and no default model are there. Pass `--model`, or set `model` in the [config file](../reference/config.md). Without it each harness uses its built-in default, which may be a provider you have no key for.
- **Give the harness a login.** A run copies the harness's credential files into its new home. A login stored in the operating system's keychain may not follow. Run `skill-evals check` on the machine first, and if it reports a login error, set the harness's API key variable.
- **Keep the results.** `--out <dir>` sets where results go. The default is a new temp directory. [Read the report](read-the-report.md) says what the directory holds.
- **Review the prompts.** Every run is unattended and has full permissions in its harness, so only run prompts you wrote or read. See [Safety](../safety.md).
