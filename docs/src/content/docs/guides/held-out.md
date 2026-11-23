---
title: Held-out prompts
description: Keep some prompts out of the loop you tune a skill in, and read how far a skill does worse on them.
---

When you tune a skill against a suite, the suite stops being a fair test of the skill: the wording of the skill drifts toward the wording of the prompts. A held-out prompt is one you do not tune against. You run it only when you want an honest number, and the report puts the two numbers side by side.

There are two ways to hold prompts out.

- Mark one variant of a case `"heldout": true`. See [Organise a suite](organise-a-suite.md#held-out-variants).
- Keep a whole directory of cases apart, and name it with `--heldout-cases <dir>` or the config key `heldoutCases`. Every case in it is held out.

Both load only with `--heldout`. Without it they are left out of `run`, `score`, `plan` and `list`.

## Keep a directory apart

Put the cases you will not tune against in a directory of their own, away from the ones you do tune against:

```text
evals/
  cases/            # you tune against these
    commit-message/
  heldout/          # you do not
    commit-message/
```

Name both in the config file:

```json
{
  "cases": ["evals/cases"],
  "heldoutCases": ["evals/heldout"]
}
```

Both keys take one path or a list. On the command line, `--cases` and `--heldout-cases` can be repeated, or take paths separated by commas.

```sh
skill-evals score                # tuning: evals/cases only
skill-evals score --heldout      # the check you do not tune against
```

### Ids with more than one directory

With one directory, case ids are what they always were. With more than one in all, held-out ones included, each id starts with the name of its directory and a slash. The cases above are `cases/commit-message` and `heldout/commit-message`, and `--case 'heldout/**'` selects the held-out ones.

- Two directories with the same name are a usage error that names both. Rename one.
- Two cases with one id are a load error.

If you add a second directory to a suite that has results, the ids in those results no longer match: `diff` and `rejudge` see the cases as new.

### What stays out of the agent's reach

A held-out directory is treated like the cases directory in every respect:

- It is left out of the copy of the subject that the agent loads, and a held-out directory that is, or holds, the subject is a usage error.
- Under `--sandbox` it is hidden from the harness process.
- The approval you give a cases directory covers it. A change to any file in it asks again.
- `validate` checks it and runs the blinding lint on it, even without `--heldout`, so that a broken held-out case does not wait for the day you run it.
- `plan`, `--resume`, `rejudge`, `diff` and `show` read the held-out cases the way they read any other.

## Read the gap

The report has a table with one row for each target skill (a name in the `targets` of a case):

```text
## Trigger recall by target skill

| skill | trigger recall (dev) | trigger recall (held-out) | gap   | false-trigger rate |
| ----- | -------------------- | ------------------------- | ----- | ------------------ |
| bro   | 1.00 (6 runs)        | 0.67 (3 runs)             | +0.33 | 0.00 (6 runs)      |
```

- **trigger recall (dev)** is the mean score of the `skill_loaded` checks on the skill, over the runs of cases with `"kind": "trigger"` that are not held out.
- **trigger recall (held-out)** is the same over the held-out cases of that kind.
- **gap** is dev minus held-out. It is `n/a` when either side has no valid run. A large gap says that the skill has learned your prompts and not the task.
- **false-trigger rate** is the share of the valid runs of cases with `"kind": "negative"` in which the `skill_not_loaded` check on the skill scored 0, which means that the skill loaded when it should not have. It counts held-out and dev cases alike.

Each cell shows how many valid runs stand behind it. A check counts for the skill it names, and for the case's `targets` when it names none. A run that is invalid counts nowhere. The table covers the subject under test, the last one or the `--bar-subject`, and gives one row for each harness when more than one ran. It gives no verdict: it shows the two numbers and leaves the call to you. `report.json` and `report.html` carry the same table; `summary.json` does not change.
