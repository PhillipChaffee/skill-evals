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

Run this in the folder that holds your skills. It writes two cases, one for each question. Replace `greet` with the name of one of your skills, the prompts with requests of your own, and `Good morning` with text that a good answer from your skill holds.

```sh
mkdir -p evals/cases/greeting-invoked evals/cases/greeting-unprompted

# What does the skill do? The prompt invokes it, and the check is about the answer.
echo 'Use the greet skill to give me a greeting to start my day.' > evals/cases/greeting-invoked/prompt.md
echo '{ "checks": [{ "type": "output_contains", "text": "Good morning" }] }' > evals/cases/greeting-invoked/case.json

# Does the skill load? The prompt does not name it, and the check is the load.
echo 'Give me a greeting to start my day.' > evals/cases/greeting-unprompted/prompt.md
echo '{ "checks": [{ "type": "skill_loaded", "skill": "greet" }] }' > evals/cases/greeting-unprompted/case.json

npx skill-evals check                              # which harnesses work on this machine
npx skill-evals run --a none --model <model-id>    # A = no skills, B = your skills
```

The report shows each case's score without your skills and with them: for the first case how often the answer held the text, and for the second how often the agent loaded the skill. [`examples/cases/hello`](https://github.com/PhillipChaffee/skill-evals/tree/main/examples/cases/hello) in the repository is one more case you can copy.

Each run starts in a new, empty home directory, so your own settings and default model are not there. Pass `--model`, or set `model` in the [config file](reference/config.md). Without it each harness uses its built-in default, which may be a provider you have no key for.

From here:

- [Write a case](guides/write-a-case.md) says how to pick the question a case asks, and why one case should not ask both.
- `--a` and `--b` each take a directory, a git ref of the project, or `none`. The defaults compare `main` (A) with the project folder and its uncommitted changes (B). See [Subjects](concepts/subjects.md).
- `skill-evals score` scores one set of skills with no comparison.
- `--min-score 0.8` makes the command exit 1 when the suite score is under 0.8, so it can gate a pull request. See [Scores](guides/pass-bars.md).
