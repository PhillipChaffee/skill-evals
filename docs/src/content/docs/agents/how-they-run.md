---
title: How each harness is started
description: How each harness loads a plugin, takes the prompt, and what it reports.
---

[Harnesses](harnesses.md) lists the harnesses in the order `run` and `score` prefer them. Pi leads because it has the smallest measured install (Pi 204 MB, OpenCode 412 MB, Codex 424 MB, Cursor 538 MB), starts in about a second, and reports tokens and cost.

| Harness       | Executable     | How a plugin is loaded                                                        | How the prompt is passed | Reports                                 |
| ------------- | -------------- | ----------------------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| `pi`          | `pi`           | `-e <dir>` with discovery switched off (`-ne -ns -np`)                        | on standard input        | tokens, cost                            |
| `claude-code` | `claude`       | `--plugin-dir <dir>`                                                          | after `--`               | tokens, cost, loaded plugins and skills |
| `cursor`      | `cursor-agent` | `--plugin-dir <dir>`                                                          | after `--`               | neither tokens nor cost                 |
| `opencode`    | `opencode`     | a `plugin` entry in the new home's `opencode.json`                            | after `--`               | tokens, cost                            |
| `codex`       | `codex`        | `codex plugin marketplace add <dir>` and `codex plugin add` into the new home | after `--`               | tokens                                  |

To use a different executable, set `SKILL_EVALS_BIN_<ID>` (for example `SKILL_EVALS_BIN_CLAUDE_CODE=/opt/bin/claude`). Use it when a version-manager shim needs your real home directory to find the binary.

## Check a harness on your machine

`skill-evals check` runs one small prompt in each installed harness. It reports whether the harness ran, whether it reported the subject as loaded, which skills the agent loaded, and which record fields the adapter filled. A harness that fails, for example because it has no login, gets its own error message in its row, and the next harness still runs.
