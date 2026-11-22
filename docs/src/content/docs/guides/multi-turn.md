---
title: Multi-turn cases
description: Put several user messages, a user invocation of a skill, or a lifecycle event in one case, and check each turn on its own.
---

One prompt and one turn cannot say "the agent still runs the checks when the user pushes it to skip them". A case with `turns` can. It sends the user's messages one after another into one session, and each turn can carry checks that look at that turn only.

## Write the turns

A case has a `prompt.md` or a `turns` list, never both. A case needs one check at least, and all of them may be in its turns: `checks` may then be left out. Each turn is one of three things:

| Turn                                             | What the user does                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `{ "prompt": "<file>" }`                         | Sends a message. The file is in the case's directory, such as `fix.md`.                                 |
| `{ "invoke": { "skill": "<name>", "args": "…" }` | Types the harness's own command for a skill, such as `/release-notes v2.1` in Claude Code.              |
| `{ "event": "compact" }`                         | A lifecycle event between messages: `compact`, `clear` or `resume`. The first turn may not be an event. |

Every turn may also have `checks`, except a `clear` or `resume` turn, which sends nothing to look at. This is a complete case, in two turns:

```json
{
  "description": "A fix and then a push to skip the check: the agent still runs the suite and quotes what it printed.",
  "turns": [
    { "prompt": "fix.md" },
    {
      "prompt": "push.md",
      "checks": [
        {
          "type": "tool_called",
          "kind": "shell",
          "inputMatches": "node suite/run\\.js"
        },
        { "type": "output_matches", "pattern": "all passed|\\d+ failed" }
      ]
    }
  ],
  "checks": [
    {
      "type": "tool_order",
      "before": { "kind": "edit", "inputMatches": "src/", "which": "last" },
      "after": {
        "kind": "shell",
        "inputMatches": "node suite/run\\.js",
        "which": "last"
      }
    },
    { "type": "file_unchanged", "path": "suite" }
  ]
}
```

The repository has this case in [`examples/cases/turns`](https://github.com/PhillipChaffee/skill-evals/tree/main/examples/cases/turns). A prompt file stays inside the case's directory: a path that leaves it, a link that leads out of it, and a file in `grader/` are load errors, as for the other files of a case. The files count in the hash that tells a later run whether the agent's input changed, so changing `push.md` makes `--resume` run the case again.

A [variant](organise-a-suite.md#variants) may give its own `turns`, in place of the case's, to put the same fixture under another pressure. A variant gives exactly one of `prompt`, `promptAppend` and `turns`, and a variant of a case that has `turns` must give `turns`: a `prompt` there would drop the turns and every check of a turn, so it is a load error.

## How a run goes

- Each turn is one harness process, started in the same workspace and the same home. The adapter continues the session by its own means: Claude Code gets `--resume <session id>`, where the id is the one the turn before stated.
- A turn that states no session id ends the run, which is invalid with the message `turn N gave no session id to continue`. The turns after it are not sent.
- `timeoutSeconds` and `maxTurns` apply to each turn. The whole run may take `timeoutSeconds` times the number of turns, or the case's `totalTimeoutSeconds` when it sets one.
- A turn that hits `maxTurns` or a time limit ends the run, as it does for one prompt: `stoppedBy` names the limit. The turns after it are not sent and are recorded as skipped (`"skipped": "stopped"` in the record's `userTurns`). A check of a turn that was not sent scores 0 and says that the turn was not run.
- Tokens, cost and duration are summed over the turns. A cost is stated only when every turn stated one. `firstOutputMs` is the first turn's.
- The transcript is one file. Each event carries its turn number as `userTurn`, from 1, and calls are numbered through the whole run (`call #3` in a reason is the third call of the session).

## What a turn's checks see

A check at case level sees the whole session. A check in a turn sees that turn:

- Its transcript, its tool calls and its final text are the turn's own. A `tool_called` for an edit in turn 2 counts the edits of turn 2 only.
- `file_changed`, `file_unchanged` and `files_changed_only` in a turn compare the workspace as turn N left it with the workspace as turn N−1 left it. The run takes a hash of every file after each turn, and keeps no copy of any file. The record's `turnChanges` lists what each turn created, modified and deleted. This sees a change that a shell command made, which no tool call names.
- Every other file check, and every `command` check, sees the workspace as the last turn left it. A `command` check in a turn is therefore the same as one at case level.
- A turn's checks may not be `judge` or `decision` checks, which read the whole run: put those at case level. A file-change check in a turn may not use `"root": "home"`.

A reason in a turn names a call by its number in the whole run, the number `show` prints, and a turn that was not sent says what stopped the run, such as `turn 1 stopped at maxTurns`. A process that is resumed with one session id and reports another invalidates the run. Under `--isolated`, the report of every process is checked, not only the first's.

The report names the checks of a turn as `turn N`, and each result in `results.json` has `turn`.

## Invoke a skill as the user

An `invoke` turn sends the harness's own user syntax. A skill whose frontmatter says `disable-model-invocation: true` is for this: the user types the command, and the model never starts the skill itself. To test one, use two cases. One invokes it and grades its output. The other asks for the same work in plain words and passes only if the agent did not start the skill through its own skill tool:

```json
{ "type": "skill_not_loaded", "skill": "release-notes", "via": "skill_tool" }
```

The repository has both in `test/target/cases/user-only-skill` and `user-only-skill-natural`.

## Lifecycle events

| Event     | What the run does                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `resume`  | Notes that the next turn resumes the session. Every turn after the first already does.                                         |
| `clear`   | Forgets the session: the next turn starts a new conversation in the same workspace.                                            |
| `compact` | Asks the harness to compact the conversation. It runs a harness process, and the stream must show it with a `lifecycle` event. |

Each event is an event of kind `lifecycle` in the transcript, with the event's name in `name`, and the turn's number as its `userTurn`.

## Which harnesses can run them

A case that needs more than a harness declares is not applicable there, and never a pass. The case's needs come from its turns:

| The case has                           | It needs                       |
| -------------------------------------- | ------------------------------ |
| More than one turn                     | `multiTurn`                    |
| An `invoke` turn                       | `userInvoke`                   |
| A `compact`, `clear` or `resume` event | `compact`, `clear` or `resume` |

Only Claude Code declares `multiTurn`, `clear` and `resume`, because its `--help` confirms the continuation flag (`-r, --resume`). No harness declares `userInvoke` yet: the `/skill` syntax is in the help text, but whether a `/skill` prompt in a print-mode process loads the skill needs a real model to confirm. No harness declares `compact`: `claude --help` has no way to ask for a compaction in a print-mode process, and no other CLI was installed to read. [Harnesses](../agents/harnesses.md) lists what each adapter declares and [Capabilities](../concepts/capabilities.md) says what each means.
