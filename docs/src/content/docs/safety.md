---
title: Safety
description: What a run is allowed to do on your machine, and what skill-evals needs.
---

> [!WARNING]
> Every run is unattended and has full permissions in its harness. The agent can run commands and write files on your machine without asking, so only run prompts you wrote or read.

## What a run can reach

Each run starts the harness in a new, empty home directory and a new workspace. Your login is copied in. Your settings and the skills you installed globally are not. [What one run does](concepts/one-run.md) has every step, and says which environment variables the harness gets.

The harness also gets only an allowlist of your environment variables, so a secret in your shell, such as a cloud key or a token, is not in its environment unless you name it in `env` in the config file. That keeps your own configuration out of the measurement. It does not confine the agent: the harness runs as you, with full permissions, so a prompt can still make it read or change anything you can.

## Requirements

`skill-evals` needs Node 22 or later and at least one of the five harnesses installed. It has no dependencies. It runs on macOS and Linux. Windows is not supported.
