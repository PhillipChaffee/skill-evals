---
title: Safety
description: What a run is allowed to do on your machine, and what skill-evals needs.
---

> [!WARNING]
> Every run is unattended and has full permissions in its harness. The agent can run commands and write files on your machine without asking, so only run prompts you wrote or read.

## What a run can reach

Each run starts the harness in a new, empty home directory and a new workspace. Your login is copied in. Your settings and the skills you installed globally are not. [What one run does](concepts/one-run.md) has every step, and says which environment variables the harness gets.

The harness also gets only an allowlist of your environment variables, so a secret in your shell, such as a cloud key or a token, is not in its environment unless you name it in `env` in the config file. That keeps your own configuration out of the measurement. It does not confine the agent: the harness runs as you, with full permissions, so a prompt can still make it read or change anything you can.

## Code that runs on your machine

A `command` check runs the shell command a case file gives it, after the agent exits. It runs as you, without a sandbox, in the run's workspace, and it can read and change anything you can. Read a case's `run` and its `grader/` folder before you run a suite you did not write, as you would read a script you were about to run.

The command does not get your shell's environment. It gets `PATH`, `TMPDIR` and `LANG` from it, the variables the tool sets (`HOME` is the run's throwaway home, and the `SKILL_EVALS_*` names say where the workspace and the held-out files are), fixed git identity variables, and the `env` of the case. It never gets a provider key. The agent cannot change the command: it only reaches it through the files it leaves in the workspace, so a command that runs code from the workspace, such as `npm test`, runs code the agent wrote. A held-out `grader/` folder is copied out only after the agent has exited, so the agent has no way to read it from the workspace or the temp directories of the run. It is still in the case's own folder on your disk, which an agent that runs with full permissions can search.

## Requirements

`skill-evals` needs Node 22 or later and at least one of the five harnesses installed. It has no dependencies. It runs on macOS and Linux. Windows is not supported.
