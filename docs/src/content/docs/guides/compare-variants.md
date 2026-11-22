---
title: Compare variants of a subject
description: Switch parts of a kit off in a copy, run up to eight subjects in one command, and read one report with a delta for each.
---

A kit does several things at once: a hook injects context, skills route, rules steer, agents take parts of a task. When a case passes, you do not know which part did the work. A variant is the same subject with one part switched off. You run the kit and its variants side by side, and the report says what each part is worth.

## Name the variants

A subject is a directory, a git ref or `none`. After it, a colon and options make a variant:

```sh
skill-evals run --cases evals/cases --reps 5 --subjects \
  "full=.,no-hook=.:hooks=off,one-skill=.:skills=only:bug-fix,none=none"
```

`--subjects name=spec,name=spec,...` takes 2 to 8 subjects, each with a label. A label is lowercase letters, digits and hyphens and starts with a letter. Labels are unique. A label may not be the id of a variant of any case in the suite, and may not be `hooks`, `rules`, `agents` or `skills`. `--subjects` replaces `--a` and `--b`; using both is a usage error. `--a` and `--b` stay, and keep the labels `a` and `b`.

| Option                 | What the copy loses                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks=off`            | Hook configuration: for Claude Code, `hooks/hooks.json`, the files that the plugin manifest's `hooks` names, and the `hooks` key of the manifest and of `.claude/settings.json`.                                                                   |
| `rules=off`            | No rule is installed, even when the config names rules.                                                                                                                                                                                            |
| `rules=on`             | The subject's rules are installed through the adapter, even where the harness would not load them from the subject. They are the config's `rules` and `instructionFile`, or the Markdown files of a `rules/` directory when the config names none. |
| `agents=off`           | Every agent definition.                                                                                                                                                                                                                            |
| `agents=except:<glob>` | The agent definitions whose name matches the glob.                                                                                                                                                                                                 |
| `skills=only:<glob>`   | Every skill whose name does not match the glob.                                                                                                                                                                                                    |
| `skills=except:<glob>` | The skills whose name matches the glob.                                                                                                                                                                                                            |

Separate options with commas, as in `.:hooks=off,skills=only:magic-*`. An option applies to a git ref and to a directory alike. A glob is the glob of `--case`, and a comma inside braces belongs to it. An unknown option, an option given twice, and a contradictory pair (`rules=on` with `rules=off`, `skills=only` with `skills=except`, `agents=off` with `agents=except`) are usage errors that name the option. A `skills` option that leaves no skill is a usage error, and so is `none` with an option. An existing path that contains a colon is a path, and wins over the grammar.

Options change the copy that every run loads, never your source. The command's check that the source did not change still applies. The harness removes what it owns: an adapter needs `strip` for `hooks=off` and `agents`. Claude Code has it. A command whose harnesses include one without it is a usage error that names the harness. Skills are filtered by name for every harness, and `rules` goes through the adapter's `installRules`. A variant's revision is the hash of the copy after the options, and the run record, `results.json` and `meta` keep the options as text, so `--resume` never takes a run of another variant.

## Read the report

The first subject is the baseline. Every other subject has a delta, an interval and a verdict against it, under the rules in [Read the report](read-the-report.md): `helped`, `hurt`, `within noise`, or `too few runs` below five valid runs on a side. The table has one `Verdict <label>` column for each subject after the first, and the report one `Suite delta <label> against <baseline>` line for each. The discrimination table takes each subject against the subject whose spec is `none`, when there is one.

```text
| Case | Score, FULL / NO-HOOK / ONE-SKILL / NONE | Verdict no-hook | Verdict one-skill | Verdict none |
| bootstrap-ablation | 1.00 / 0.00 / 0.50 / 0.00 (...) | hurt (−1.00, 95% −1.00..−1.00) | hurt (−0.50, ...) | hurt (−1.00, ...) |
```

Here the hook is worth the whole score, one skill is worth half of it, and the kit is worth more than nothing. A [noise file](jobs-resume-plan.md) from `calibrate` says which of these deltas are real: a delta no larger than the noise bound reads `within noise`.

Every report format, `summary.json`, `diff` and `rejudge` handle any number of subjects. `results.json` keeps its shape for two subjects: `comparison` is B against A, and the new `comparisons` lists one entry for each subject after the baseline, with its `subject` and `baseline`.

## Set the bars

`--min-score`, `--min-delta` and a case's `minScore` and `minDelta` apply to the last subject. `--bar-subject <label>` moves them to another subject, and a label that does not exist is a usage error. A delta bar compares the bar subject with the baseline, so the baseline cannot be the bar subject when a delta bar is set.

```sh
skill-evals run --cases evals/cases --subjects "kit=.,lean=.:hooks=off,none=none" \
  --bar-subject lean --min-score 0.8 --min-delta 0.3
```

## A case that suits an ablation

A routing case grades whether the right skills loaded, which is what a hook or a skill change moves.

```json
{
  "description": "A bug report with two causes: the entry skill and the ranking skill both load.",
  "tags": ["routing", "ablation"],
  "targets": ["bug-fix", "triage"],
  "checks": [
    { "type": "skill_loaded", "skill": "bug-fix" },
    { "type": "skill_loaded", "skill": "triage" }
  ],
  "timeoutSeconds": 300
}
```

Run it with five reps or more, so that each side has enough runs for a verdict.

## Check what a harness can report

`skill-evals check --json` prints an array with one entry for each harness: `harness`, `installed`, `status`, `capabilities` (a boolean for every capability), `loaded`, `pluginLoaded`, and the counts `skills`, `agents`, `rules`, `hooksFired` and `mcpServers`. A count is `null` where the harness cannot report it. The table has the same columns. Use it to see, before an ablation, whether a harness reports the skills, agents and hooks that your variants switch off.
