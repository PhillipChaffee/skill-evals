---
title: Safety
description: What a run is allowed to do on your machine, what runs outside the sandbox, and what skill-evals asks before it starts.
---

> [!WARNING]
> Every run is unattended and has full permissions in its harness. The agent can run commands and write files on your machine without asking, so only run prompts you wrote or read. `--sandbox` narrows what the agent can reach. It does not make an untrusted suite safe.

## What a run can reach

Each run starts the harness in a new, empty home directory and a new workspace. Your login is copied in. Your settings and the skills you installed globally are not. [What one run does](concepts/one-run.md) has every step, and says which environment variables the harness gets.

The harness also gets only an allowlist of your environment variables, so a secret in your shell, such as a cloud key or a token, is not in its environment unless you name it in `env` in the config file. That keeps your own configuration out of the measurement. It does not confine the agent: without `--sandbox` the harness runs as you, with full permissions, so a prompt can still make it read or change anything you can.

## Code that runs on your machine

Four parts of a suite run code that the case author wrote. All of them run as you. None of them runs in the sandbox.

### Command checks

A `command` check runs the shell command a case file gives it, after the agent exits, in the run's workspace. It can read and change anything you can. Read a case's `run` and its `grader/` folder before you run a suite you did not write, as you would read a script you were about to run.

The command does not get your shell's environment. It gets `PATH`, `TMPDIR` and `LANG` from it, the variables the tool sets (`HOME` is the run's throwaway home, and the `SKILL_EVALS_*` names say where the workspace and the held-out files are), fixed git identity variables, and the `env` of the case. It never gets a provider key. The agent cannot change the command: it only reaches it through the files it leaves in the workspace, so a command that runs code from the workspace, such as `npm test`, runs code the agent wrote.

A held-out `grader/` folder is copied out only after the agent has exited, so the agent cannot read it from the workspace or from the temp directories of the run. It is still in the case's own folder on your disk, which an agent that runs with full permissions can search, read and change: that includes the `grader/` folder and `case.json`, so an agent can in principle edit its own grader. A background process the agent leaves can outlive the run, and a command can leave one that escapes its process group.

### Setup scripts

A `setup` step runs the same way: as you, in the workspace, before the agent starts. It gets the environment of a `command` check (no provider key, no login file in the home, git configuration switched off) plus `SKILL_EVALS_REMOTE_DIR` and `SKILL_EVALS_FIXTURE_DIR`. Nothing stops a step from writing outside the workspace, from reading your files, or from starting a process that outlives the run, and a `git worktree add ../wt` puts a directory next to the workspace without any complaint. Read the `setup` of a case, and the scripts in its `fixture/` folder, before you run a suite you did not write.

### Mock MCP servers

A case with mock MCP servers adds processes of its own. Claude Code starts a copy of the mock server for each server of the case, from a temporary directory outside the workspace and the home. The agent can read that directory like any other file it can reach, so it can read the specs: the tools, the arguments each response waits for, and the text each one returns. Do not put anything in a mock spec that the agent must not see.

The servers answer from the case's files and call nothing real. A run that reports any other MCP server is invalid. A logged-in headless Claude Code would otherwise sync your claude.ai connectors, so a mock case sets `ENABLE_CLAUDEAI_MCP_SERVERS=false` for it.

The servers are sealed: the tool hashes every file they run from before the harness starts, and again when it ends. An agent that edits a server, or adds a file to its directory, makes the run invalid. An agent that writes into the servers' log cannot change a score either: the log must agree with the stream, or the run is invalid.

## The sandbox

`--sandbox` runs each harness process in an OS sandbox. It is off by default, and `sandbox` in the config file turns it on for a project.

| Platform | Backend              | Found by                             |
| -------- | -------------------- | ------------------------------------ |
| Linux    | `bwrap` (bubblewrap) | an executable of that name on `PATH` |
| macOS    | `sandbox-exec`       | an executable of that name on `PATH` |

With no backend, the command exits 2 with `no sandbox backend found (looked for bwrap, sandbox-exec)`. It never runs unsandboxed when you asked for the sandbox.

Inside the sandbox the whole filesystem is read-only except the run's workspace, its throwaway home, and a temp directory of its own, which the agent gets as `TMPDIR`. On Linux the process also gets a fresh `/dev` and `/proc` and every namespace unshared, and it dies with the command. On macOS the same writable set is a `sandbox-exec` profile that denies every other write.

### What the sandbox does not cover

- **Graders run outside it.** The sandbox wraps the harness process and nothing else. Setup steps, the harness's own setup (such as installing a plugin), `command` checks and the judge run as you, because they are code that you or the suite's author chose. A sandbox does not make a suite you did not read safe to run.
- **It does not hide files.** The agent can still read everything you can read, your cases directory and your `grader/` folders included. Only writes are confined. The login of the harness is in the throwaway home, so the agent has it.
- **`provider-only` is unsupported.** Neither backend can allow one set of hosts and deny the rest, so a case with `"network": "provider-only"` is not applicable under `--sandbox`, with the reason `the sandbox cannot enforce provider-only`.
- **The macOS backend is deprecated by Apple.** It still works. Test your suite on the machine that runs it.

### Network policy

A case may say `"network": "off" | "provider-only" | "open"`. The default is `open`, and a case that does not set it hashes as it always did.

| `network`           | Without `--sandbox`                                     | With `--sandbox`                                           |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `open` (or not set) | runs                                                    | runs, with the network shared                              |
| `off`               | not applicable: `network off needs --sandbox`           | runs with no network                                       |
| `provider-only`     | not applicable: `network provider-only needs --sandbox` | not applicable: `the sandbox cannot enforce provider-only` |

A case that needs the network to be off never runs open. The report lists it under "Not applicable" with the reason, with no runs and no score. An agent that has no network cannot reach the model provider either, so `off` is for a harness that works against a local endpoint.

## Prompt review

The prompts of a suite are code in all but name: they run with full permissions. Two things let you read them first.

`list --show-prompts` prints every prompt of each selected case: each turn of a case with `turns`, and whether a history preamble is added in front of the first.

`score`, `run` and `calibrate` check whether the cases directory is approved before any harness starts. The approval is the sha256 of the directory's real path and its content, kept in `approved.json` in the state directory: `$SKILL_EVALS_STATE_DIR`, else `$XDG_STATE_HOME/skill-evals`, else `~/.local/state/skill-evals`.

- A directory that is not approved asks `run these N cases? [y/N]` when standard input is a terminal, and remembers a yes.
- Without a terminal the command exits 2, unless you pass `--yes`. `--yes` runs without asking and without remembering, which is what a CI job wants.
- A change to any file of the directory, or moving it, is a new directory and asks again.

`--dry-run` and `plan` start nothing, so they do not ask.

## Canaries

`no_writes_outside_workspace` is an opt-in check for what the agent does when nobody is watching. Before the harness starts and after it ends, the tool hashes a set of canaries. It keeps hashes and never contents.

- The dotfiles of your real home: the paths the adapter names for its own state (for Claude Code, `~/.claude` and `~/.claude.json`), and `~/.gitconfig`, `~/.npmrc` and `~/.ssh`.
- The project root, without `.git`, `node_modules` and the output directory, up to 5,000 files.

The check scores 0, and says why, when a canary changed, when a shell call pushes to a git remote that is not on this machine, and when a shell call publishes: `npm`, `pnpm` or `yarn publish`, `cargo publish`, `twine upload`, or `gh release create`, `upload`, `edit` or `delete`. A `--dry-run` does not count. The agent is never told about the canaries.

A canary is not a guard. It records that a write happened, after the fact, and it cannot see a write through a path it does not watch. Another process that writes the same paths while the run is in flight counts, so a Claude Code session of your own that is open in the same home changes `~/.claude` during a run. Use `--sandbox` to prevent the writes and the check to see which ones were tried.

## Requirements

`skill-evals` needs Node 22 or later and at least one of the five harnesses installed. It has no dependencies. It runs on macOS and Linux. Windows is not supported.
