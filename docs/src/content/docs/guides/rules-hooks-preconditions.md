---
title: Rules, hooks and preconditions
description: Install a subject's rules, read the hooks that ran, check that a rule reached the model, and make a run invalid when it did not.
---

A rule that never loaded cannot be obeyed, and a case that grades the obedience then measures nothing. This guide shows how to install a subject's rules, how to see that a hook ran or that text reached the model, and how to keep a case from scoring a run in which it did not.

## Name the rules

Two config keys name a subject's rules. Both are paths inside the subject.

```json
{
  "rules": "rules",
  "instructionFile": "AGENTS.md"
}
```

`rules` is a directory, and every `.md` file in it is a rule; any other file is not installed, and the command warns. The instruction file may not be inside the rules directory. `instructionFile` is one file that the harness reads as its instructions. A path that leaves the subject, a link, or a path that does not exist is a usage error, and the `none` subject has no rules.

An adapter with the `rules` capability installs the files the way its harness reads them, once, before the harness starts. The run record keeps what happened:

```jsonc
{
  "rules": {
    "installed": ["home/.claude/rules/waiting.md", "home/.claude/CLAUDE.md"],
    "reportedLoaded": null,
  },
}
```

`installed` is where the adapter put each file, as `home/<path>` or `workspace/<path>`. `reportedLoaded` is what the harness says it loaded, relative to the run's home like `installed`: null when it says nothing. A harness without the `rules` capability installs nothing, and `installed` is empty.

A rule is never installed over a file. If a case's `workspace/`, a shared fixture or its `home/` has a file where an adapter would put a rule, or any file in the directory the rules go into (for Claude Code, `home/.claude/rules/`), the command stops before any run, and `validate` reports it as a problem. The message names both files and says which to change.

### What each adapter does

| Harness     | Declares `rules` | Where the files go                                                                                        | Declares `rulesReport` |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| Claude Code | yes              | `<config dir>/rules/<file>` and `<config dir>/CLAUDE.md`, in the run's home; both load under `--isolated` | no                     |
| Others      | no               | Not installed                                                                                             | no                     |

The mechanism of Claude Code was read from the binary's strings, not from a real run. [The design note](https://github.com/PhillipChaffee/skill-evals/blob/main/docs/design/rules-hooks-preconditions.md) has the evidence for each adapter and what is still unconfirmed.

## Read the hooks that ran

An adapter whose stream shows hooks emits a transcript event of type `hook`:

```jsonc
{
  "event": "SessionStart",
  "command": null,
  "exit": 0,
  "contextBytes": 41,
  "context": "Use the using-the-kit skill before you act.",
}
```

A field the stream does not carry is null. `context` is what the hook put in front of the model. For Claude Code that is the `additionalContext` of the hook's JSON output for any event, or the plain standard output of a `SessionStart` or `UserPromptSubmit` hook that succeeded; the output of any other hook is not context. The transcript file keeps up to 64,000 characters, and `context_injected` reads them; records, `show` and reports display the first 4,000. Each cut is stated in the text, and `contextBytes` keeps the size before it. A hook event is never a tool call, so `tool_called` and the other tool checks do not count it.

`hook_fired` counts the hooks of one event:

```json
{ "type": "hook_fired", "event": "SessionStart" }
```

`min` is 1, and 0 when `max` is 0, as for `tool_called`. A `min` of 0 with no `max` can never fail, so it is a load error, for `tool_called` too. `hook_fired` needs the `hooks` capability.

## Check what reached the model

`context_injected` tests a regular expression against the context that hooks added and against the rule and instruction text that the harness reports it loaded:

```json
{
  "type": "context_injected",
  "pattern": "30 seconds",
  "source": "rules"
}
```

`source` is `hooks`, `rules` or `any` (the default). It needs `hooks` for `hooks`, `rulesReport` for `rules`, and one of them for `any`. `rulesReport` means that the harness reports the rule and instruction texts it loaded; installing them (`rules`) proves nothing about what the model saw. The check never reads the files that the run installed. Claude Code reports no rule text, so it does not declare `rulesReport`: a case that needs `source: "rules"` is not applicable there, and costs nothing, until a harness can report its rules.

## Make a run invalid instead of zero

`preconditions` is a list of checks that say what the run must have started with:

```json
{
  "preconditions": [
    { "type": "context_injected", "pattern": "30 seconds", "source": "rules" }
  ],
  "checks": [
    {
      "type": "tool_not_called",
      "kind": "shell",
      "inputMatches": "sleep\\s+(3[1-9]|[4-9]\\d|\\d{3,})"
    }
  ]
}
```

Only `context_injected`, `hook_fired` and `skill_available` may be preconditions. Any other type is a load error, because a precondition says what the run started with, not what the agent did. `skill_loaded` is the behaviour that a case tests, so it is not one.

- Preconditions are scored first. One that scores 0 makes the run invalid with `precondition not met: <check>`, not a zero.
- The judged, decision and command checks of such a run are not run, so no judge or command is spent on it. Each says why it was left alone.
- A precondition never counts in the run's score, so it takes no `weight`.
- What a precondition needs makes the case not applicable on a harness that lacks it, as for any check. A precondition is never skipped, so it takes no `ifUnsupported`; `weight` and `ifUnsupported` on one are load errors.
