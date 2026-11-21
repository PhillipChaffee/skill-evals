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

There is one row for each name in the `targets` of a selected case. `dev` counts the cases that are not guards, and `guards` the guard cases. `held-out` counts the held-out variants that are not guards (see below), and `dev` counts the rest.

## Give a case its own settings

| Key          | Effect                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reps`       | Runs for each subject in this case, in place of `--reps`.                                                                                                                            |
| `model`      | The model of the agent in this case's runs, in place of `--model`.                                                                                                                   |
| `judgeModel` | The model that scores this case's judged checks, in place of `--judge-model`.                                                                                                        |
| `env`        | Variables the agent's process gets. A name starts with `CASE_`, or is `TZ`, `LANG` or `LC_ALL`. The values are set outright, and a value of the same name in your shell is not used. |

A name outside that set is a load error, so a case cannot set the key of the decision model, which stays out of every harness's environment. A value may not hold a NUL character. A model set in a case does not change the judge's default: the judge still falls back to `--model`, unless the case also sets `judgeModel`. `results.json` records each case's overrides, tags and targets under `caseMeta`.

`env` applies to the agent only. `minDelta`, a number from -1 to 1, is read and kept for the comparison bar that a later release adds. A negative value means that B may score lower than A by at most that much.

## Variants

A skill should answer to what a person means, not to one wording. A variant puts a case's prompt a different way, with the same fixture, checks and settings, so you do not copy the directory. Add a `variants` list to `case.json`:

```json
{
  "tags": ["routing"],
  "targets": ["commit-message"],
  "checks": [{ "type": "skill_loaded", "skill": "commit-message" }],
  "variants": [
    {
      "id": "paraphrase",
      "prompt": "Could you draft a message for the commit I am about to make?"
    },
    {
      "id": "hurry",
      "promptAppend": "I am in a hurry, so do not ask me anything.",
      "tags": ["pressure"]
    }
  ]
}
```

Each variant runs as its own case, with the id `<case id>@<variant id>`, such as `routing/commit-help@hurry`. A case with variants never runs bare.

- A variant has an `id`: lowercase letters, digits and hyphens, unique within the case.
- A variant has exactly one of `prompt` and `promptAppend`. `prompt` is the whole prompt. `promptAppend` is added to the case's `prompt.md`, after a blank line, so the case needs a `prompt.md`. A case whose variants all have a `prompt` needs none, and then an empty `prompt.md` is fine; only `promptAppend` needs a `prompt.md` with text. A `prompt` or `promptAppend` of only whitespace is a load error.
- A variant's `tags` are added to the case's tags for that variant, and `--tag`, `--tag-all` and `--not-tag` see the merged tags.
- A `--case` or `--not-case` glob matches a variant by its full id or by the case's id, so `--case routing/commit-help` selects every variant and `--case "**@hurry"` selects one kind.
- Keys of a variant other than `id`, `prompt`, `promptAppend`, `heldout` and `tags` are load errors, unless they start with `x-`.

The same rule about words applies as for any prompt: keep `eval`, `test`, `judge`, `benchmark` and the others from [Write a case](write-a-case.md) out of a variant's prompt.

`results.json` keys `caseMeta` by the full id, and each entry also has `base` (the case's id), `variant` (the variant's id, or null) and `heldout`.

## Held-out variants

When you tune a skill against a suite, the suite stops being a fair test of the skill. Mark a variant `"heldout": true` to keep it out of that loop. A held-out variant is left out of `run`, `score` and `list` until you pass `--heldout`, and then it runs in addition to the others:

```sh
skill-evals run                 # tuning: the dev variants only
skill-evals run --heldout       # the check you do not tune against
```

A case whose variants are all held out is neither listed nor run without `--heldout`. If you select only such a case, the command fails with the usual "no case matches" error, and says that held-out variants need the flag. The coverage table counts the held-out variants that are not guards in its `held-out` column. A held-out variant of a `guard: true` case counts under `guards`, because a guard is a guard first, and every other variant that is not a guard counts in `dev`.
