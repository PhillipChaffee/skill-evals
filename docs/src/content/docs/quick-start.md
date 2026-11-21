---
title: Quick start
description: Install skill-evals, write one case, and get a first score.
---

Read [Safety](safety.md) first: every run is unattended and has full permissions in its harness.

## Install

```sh
npm install --save-dev skill-evals   # or run it without installing: npx skill-evals <command>
```

## Run a first case

Run this in the folder that holds your skills. Replace `greet` with the name of one of your skills, and the prompt with a request that should make the agent use it.

```sh
mkdir -p evals/cases/greeting
echo 'Give me a greeting to start my day.' > evals/cases/greeting/prompt.md
echo '{ "checks": [{ "type": "skill_loaded", "skill": "greet" }] }' > evals/cases/greeting/case.json
npx skill-evals check                              # which harnesses work on this machine
npx skill-evals run --a none --model <model-id>    # A = no skills, B = your skills
```

The report shows how often the agent loaded the skill without your skills (0 of 3) and with them. [`examples/cases/hello`](https://github.com/PhillipChaffee/skill-evals/tree/main/examples/cases/hello) in the repository is one more case you can copy.

Each run starts in a new, empty home directory, so your own settings and default model are not there. Pass `--model`, or set `model` in the [config file](reference/config.md). Without it each harness uses its built-in default, which may be a provider you have no key for.

From here:

- `--a` and `--b` each take a directory, a git ref of the project, or `none`. The defaults compare `main` (A) with the project folder and its uncommitted changes (B). See [Subjects](concepts/subjects.md).
- `skill-evals score` scores one set of skills with no comparison.
- `--min-score 0.8` makes the command exit 1 when the suite score is under 0.8, so it can gate a pull request. See [Scores](guides/pass-bars.md).
