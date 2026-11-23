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

Three parts of a suite run code that the case author wrote: command checks, setup scripts and mock MCP servers. All of them run as you. The mock servers run inside the sandbox, with the harness, and under `--sandbox` so does the judge's harness process. Command checks and setup scripts do not; neither does the harness's own setup.

### Command checks

A `command` check runs the shell command a case file gives it, after the agent exits, in the run's workspace. It can read and change anything you can. Read a case's `run` and its `grader/` folder before you run a suite you did not write, as you would read a script you were about to run.

The command does not get your shell's environment. It gets `PATH`, `TMPDIR` and `LANG` from it, the variables the tool sets (`HOME` is the run's throwaway home, and the `SKILL_EVALS_*` names say where the workspace and the held-out files are), fixed git identity variables, and the `env` of the case. It never gets a provider key. The agent cannot change the command: it only reaches it through the files it leaves in the workspace, so a command that runs code from the workspace, such as `npm test`, runs code the agent wrote. That code runs as you, outside the sandbox, and after the canary window has closed, so neither `--sandbox` nor `no_writes_outside_workspace` sees it. A suite whose command checks run what the agent wrote is as safe as that code, whatever flags you pass.

A held-out `grader/` folder is copied out only after the agent has exited, into the run's own temp directory, so the agent cannot read it from the workspace, and the agent of another run does not find it in its `TMPDIR`. Each run gets a temp directory of its own as `TMPDIR`, with or without `--sandbox`, and the default output directory is in the state directory, not in the system's temp directory. That only keeps this tool's own files out of the agent's `TMPDIR`. Without `--sandbox` the agent runs as you and can read what you can, the system's temp directory and the output directory included. Use `--sandbox` to confine it. The `grader/` folder is still in the case's own folder on your disk, which an agent that runs with full permissions can search, read and change: that includes the `grader/` folder and `case.json`, so an agent can in principle edit its own grader. A background process the agent leaves can outlive the run, and a command can leave one that escapes its process group.

### The judge

A `judge` check sends a prompt to a harness, which then reads text that the agent wrote: its final answer, and the files and transcript the check lists. That text can hold instructions for the judge. The judge session is started with no tools and one turn, so it can only answer: Claude Code gets `--tools ""` and `--max-turns 1`. A harness whose adapter has no switch for its tools keeps them, and the command warns once; use `--sandbox`, Claude Code or `judgeApi` for the judge. Under `--sandbox` the judge's harness process runs in the same sandbox as the agent's, with the network open so that it can reach its model. A judge through `judgeApi` starts no process.

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

With no backend, the command exits 2 with `no sandbox backend found (looked for bwrap, sandbox-exec)`. It also starts the backend once before any run, with the same mounts a run uses (`bwrap --ro-bind / / --tmpfs /tmp --dev /dev --proc /proc --unshare-all true`) and exits 2 when that fails, as it does where user namespaces are off. It never runs unsandboxed when you asked for the sandbox.

### What it does on Linux

The filesystem is bound read-only, in this order, and then these parts are put back:

1. `/` is read-only.
2. An empty temporary filesystem hides your real home, the temp directories, `/run` (and `/var/run`), the cases directory, the output directory and the project root. That takes the credentials in your home, the cases and grader files, the output of other runs, and the Unix sockets under `/run` and `/tmp` out of the agent's view: the Docker socket, the user bus and ssh-agent.
3. What the harness needs is bound back, read-only: its own install; Node (the one that runs this tool and the one on `PATH`, behind a shim or not) with its install root; the directories of `PATH` that were hidden, unless one is your home, `.`, the cases directory or another hidden directory, which is warned about once; each file that a certificate variable (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the others) or a variable of `env` names, as the file itself; the directory that `/etc/resolv.conf` points into; the run's copy of the subject; and the paths of `sandboxExpose`.
4. A fresh `/dev` and `/proc`, with every namespace unshared. The process dies with the command.
5. Writable: the run's workspace, its throwaway home, a temp directory of its own (the agent gets it as `TMPDIR`), the run's fixture remotes, and the mock servers' log file.
6. The mock servers' own directory is read-only, and then the log inside it is writable again.

### What the sandbox does not cover

- **Graders run outside it.** The sandbox wraps the harness processes, the agent's and the judge's, and nothing else. Setup steps, the harness's own setup (such as installing a plugin) and `command` checks run as you, because they are code that you or the suite's author chose. A `command` check can run code the agent wrote, after the run, outside the sandbox and outside the canary window.
- **It hides only what is listed.** Your system directories, `/etc`, and everything outside the hidden directories stay readable. The login of the harness is in the throwaway home, so the agent has it. With the network open, the agent can use it.
- **`provider-only` is unsupported.** Neither backend can allow one set of hosts and deny the rest, so a case with `"network": "provider-only"` is not applicable under `--sandbox`, with the reason `the sandbox cannot enforce provider-only`.
- **macOS hides nothing.** The `sandbox-exec` profile only denies writes outside the writable set and, for `off`, the network. Your home, the cases and the sockets stay readable. The profile allows `/dev/null`, `/dev/tty`, `/dev/ptmx` and the terminal devices; a harness that needs XPC or mach helpers to start may fail under it, and Apple deprecates `sandbox-exec`. Test your suite on the machine that runs it.
- **What is bound back stays visible.** A harness installed in a hidden directory has its install and its `PATH` directories readable. For a layout the sandbox does not know, list absolute paths in `sandboxExpose` in the config file: each is bound back read-only, and none may be your real home or the cases directory.

### What was never run

No test ran the real `bwrap` or `sandbox-exec`: the tests use a stand-in that logs the arguments it was given and runs the command unconfined. The lists above say what the wrap asks of the backend, not what the backend did. The brief's `todo` tool kind is not built (Task 29), and the excuse that lets a run stopped at its limits be scored, although its stream has no ending, is unconfirmed on real streams. [What was verified](agents/verified.md#not-verified) has the details.

### Network policy

A case may say `"network": "off" | "provider-only" | "open"`. The default is `open`, and a case that does not set it hashes as it always did.

| `network`           | Without `--sandbox`                                     | With `--sandbox`                                           |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `open` (or not set) | runs                                                    | runs, with the network shared                              |
| `off`               | not applicable: `network off needs --sandbox`           | runs with no network                                       |
| `provider-only`     | not applicable: `network provider-only needs --sandbox` | not applicable: `the sandbox cannot enforce provider-only` |

A case that needs the network to be off never runs open. The report lists it under "Not applicable" with the reason, with no runs and no score. `off` also cuts the agent off from the model provider, so it is for a harness that talks to a local model. A Claude Code case that must be sandboxed uses `open`.

## Prompt review

The prompts of a suite are code in all but name: they run with full permissions. Two things let you read them first.

`list --show-prompts` prints every prompt of each selected case: each turn of a case with `turns`, the history preamble with every message in it, and the shell commands that run on your machine: the `run` of each setup step and of each `command` check.

`score`, `run` and `calibrate` check whether the cases directory is approved before any harness starts. The approval is the sha256 of the directory's real path and its content, and of the content of the project's config file, kept in `approved.json` in the state directory: `$SKILL_EVALS_STATE_DIR`, else `$XDG_STATE_HOME/skill-evals`, else `~/.local/state/skill-evals`.

- A directory that is not approved asks `<directory> has not been approved (see them with "skill-evals list --show-prompts"). Run these N cases? [y/N]` when standard input is a terminal, and remembers a yes. When the state directory cannot be written, it warns and approves for that run only.
- Without a terminal the command exits 2, unless you pass `--yes`. `--yes` runs without asking and without remembering, which is what a CI job wants.
- A change to any file of the directory or of the config file, or moving the directory, asks again.

`--dry-run` and `plan` start nothing, so they do not ask.

## Canaries

`no_writes_outside_workspace` is an opt-in check for what the agent does when nobody is watching. Before the harness starts and after it ends, the tool hashes a set of canaries. It keeps hashes and never contents.

- What a person edits to change the harness, in your real directory. For Claude Code: `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`, `skills`, `commands`, `hooks` and `plugins/installed_plugins.json` under `~/.claude` (or `$CLAUDE_CONFIG_DIR`), and the `mcpServers` of `~/.claude.json`, with the `mcpServers` and `allowedTools` of each of its projects. Not the login, and not the history and caches that a live session rewrites every turn.
- `~/.gitconfig`, `~/.npmrc` and `~/.ssh`.
- The project root, without `.git`, `node_modules` and the output directory. In a git repository the files are the ones `git ls-files -co --exclude-standard` lists; otherwise the tool walks the directory.

A watch that reaches the cap of 5,000 files in the project root or in one canary directory is not complete, and the check scores 0 with `not fully watched`. It does not pass on the part it saw.

The check scores 0, and says why, when a canary changed, when a shell call pushes to a git remote that is not on this machine, and when a shell call publishes: `npm`, `pnpm` or `yarn publish`, `cargo`, `uv` or `poetry publish`, `twine upload`, `gem push`, `docker push`, or `gh release create`, `upload`, `edit` or `delete`. The tool looks through `env`, `timeout`, `command`, `nice`, `sudo`, `npx`, `sh -c` and a leading `cd`, and a push with no remote goes where the branch's `pushRemote`, then `remote.pushDefault`, then `origin` says. A `--dry-run` does not count for a publish, and `git push --dry-run` and `git push -n` do not count either, because none of them sends anything. A reason never shows the user or password of a URL. The agent is never told about the canaries.

A canary is not a guard. It records that a write happened, after the fact, and it cannot see a write through a path it does not watch or code that runs after the window (see command checks). Another process that writes the same paths while the run is in flight counts. Use `--sandbox` to prevent the writes and the check to see which ones were tried.

## Requirements

`skill-evals` needs Node 22 or later and at least one of the five harnesses installed. It has no dependencies. It runs on macOS and Linux. Windows is not supported.
