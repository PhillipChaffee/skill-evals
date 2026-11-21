---
title: Organise a suite
description: Put cases in nested folders, label them with tags, and select the ones a run needs.
---

A suite of a few cases fits in one folder. A suite of hundreds does not, and you rarely want to run all of it. This page shows how to nest cases, label them, select a part of the suite in one command, and give a case its own settings.

## Nest the cases

A case is a directory that holds a `prompt.md` or a `case.json`. It can be at any depth under the cases directory, and its id is its path below that directory, written with `/`:

```text
evals/cases/
  routing/
    bug/first-report/      id: routing/bug/first-report
    bug/second-report/     id: routing/bug/second-report
  pressure/
    deadline/              id: pressure/deadline
  _drafts/                 never loaded
```

These rules decide what is a case:

- A directory that starts with `_` is skipped, with everything under it. Use it for drafts and shared notes. A 0.0.1 case directory whose name starts with `_` stops being a case.
- Nothing under a case directory is searched. A `prompt.md` inside `workspace/` is a workspace file, never a case.
- A directory name that is part of a case id may not hold `@` or `,`. That is a load error. Dots and hyphens are fine: `core/trig.rsch.research.01` is a legal id.
- A directory with a `case.json` and no `prompt.md` is a load error that says there is no prompt source.

The results go in `<out>/<harness>/<case id>/`, so a nested id makes nested directories.

## Label the cases

These keys of a `case.json` help you find and sort cases. [Checks](../reference/checks.md#case-file-keys) lists all keys.

| Key           | Holds                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `tags`        | A list of labels. Each is lowercase letters, digits and hyphens, and starts with a letter or digit. |
| `targets`     | The names of the skills the case is about.                                                          |
| `guard`       | `true` for a case that must keep passing.                                                           |
| `kind`        | The kind of case, such as `trigger` or `negative`.                                                  |
| `description` | What the case shows, in a sentence.                                                                 |
| `expected`    | What a good run does, in a sentence. No check reads it.                                             |

A guard case is scored like any case, and its score counts in the suite score. The report lists it in its own table, under the heading `Guard cases`, so that the cases you are trying to improve stand apart from the ones that must not break.

Here is one complete case file:

```json
{
  "description": "A question that is not about writing a commit message.",
  "tags": ["smoke", "routing", "negative"],
  "targets": ["commit-message"],
  "kind": "negative",
  "guard": true,
  "reps": 2,
  "checks": [{ "type": "skill_not_loaded", "skill": "commit-message" }]
}
```

The repository has this case in [`examples/cases/routing/commit-guard`](https://github.com/PhillipChaffee/skill-evals/tree/main/examples/cases/routing/commit-guard).

## Select cases

These flags go with `run`, `score` and `list`. Each one can be given more than once, and takes a comma-separated list.

| Flag                 | A case is chosen when             |
| -------------------- | --------------------------------- |
| `--case <globs>`     | Its id matches any of the globs.  |
| `--not-case <globs>` | Its id matches none of the globs. |
| `--tag <tags>`       | It has any of the tags.           |
| `--tag-all <tags>`   | It has all of the tags.           |
| `--not-tag <tags>`   | It has none of the tags.          |

A case must pass every flag you give. With none, every case is chosen. A command that chooses no case exits with code 2 and says which selection matched nothing.

A glob is matched against the whole id. `*` matches any run of characters except `/`, `**` matches any run including `/`, `?` matches one character, and `{a,b}` matches either. A comma inside braces belongs to the glob and does not split the list.

```text
skill-evals score --case "routing/**" --case "pressure/{deadline,crunch}" --not-case "**/slow-*"
skill-evals run --tag smoke,core --not-tag slow
skill-evals list --tag core --tag-all routing
```

The `--case` flag of 0.0.1 took one glob where only `*` was special, and ids were flat. A value whose only special character is `*` selects what it selected before. `*` no longer crosses `/`, so use `**` for a nested suite. These characters were plain text in 0.0.1 and now mean something: `?`, `{`, `}` and `\` are glob syntax, and `,` separates values. A value that holds one of them selects differently.

## Count the coverage

The report ends with a table of the target skills, and `list --targets` prints the same table without running anything:

```text
| skill          | cases | dev | held-out | guards |
| -------------- | ----- | --- | -------- | ------ |
| commit-message | 12    | 9   | 0        | 3      |
```

There is one row for each name in the `targets` of a selected case. `dev` counts the cases that are not guards, and `guards` the guard cases. `held-out` is 0 until held-out cases exist.

## Give a case its own settings

| Key          | Effect                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reps`       | Runs for each subject in this case, in place of `--reps`.                                                                                                                            |
| `model`      | The model of the agent in this case's runs, in place of `--model`.                                                                                                                   |
| `judgeModel` | The model that scores this case's judged checks, in place of `--judge-model`.                                                                                                        |
| `env`        | Variables the agent's process gets. A name starts with `CASE_`, or is `TZ`, `LANG` or `LC_ALL`. The values are set outright, and a value of the same name in your shell is not used. |

A name outside that set is a load error, so a case cannot set the key of the decision model, which stays out of every harness's environment. A value may not hold a NUL character. A model set in a case does not change the judge's default: the judge still falls back to `--model`, unless the case also sets `judgeModel`. `results.json` records each case's overrides, tags and targets under `caseMeta`.

`env` applies to the agent only. `minDelta`, a number from -1 to 1, is read and kept for the comparison bar that a later release adds. A negative value means that B may score lower than A by at most that much.
