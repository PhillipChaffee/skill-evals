# Cases and checks

How to write a case, and every check a case can hold. The commands that run the cases are in [Commands and reports](commands.md).

## Write a case

A case is a directory under `evals/cases/`. Its name is the case id.

| File         | Content                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt.md`  | The prompt, exactly as a user would type it. Nothing else.                                                                                             |
| `case.json`  | `{ "checks": [...], "weight": 1, "minScore": 0.5, "maxTurns": 6, "timeoutSeconds": 600 }`. Only `checks` is required, and it needs at least one check. |
| `workspace/` | Optional. Files the agent finds in its working directory.                                                                                              |

Every check takes an optional `weight`, a positive number that defaults to 1.

| Check                 | Fields                                                              | Scores 1 when                                                                                              |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `skill_loaded`        | `skill`                                                             | The agent loaded that skill.                                                                               |
| `skill_not_loaded`    | `skill`                                                             | The agent did not load it.                                                                                 |
| `output_contains`     | `text`                                                              | The final answer contains that text. The match is exact and case-sensitive.                                |
| `output_not_contains` | `text`                                                              | The final answer does not contain it.                                                                      |
| `output_matches`      | `pattern`, optional `flags`                                         | The final answer matches the regular expression.                                                           |
| `output_lacks`        | `pattern`, optional `flags`                                         | The final answer does not match it.                                                                        |
| `file_exists`         | `path`                                                              | That file exists in the workspace after the run.                                                           |
| `file_matches`        | `path`, `pattern`, optional `flags`                                 | That file exists and matches.                                                                              |
| `tool_called`         | `kind` or `name` or both, optional `inputMatches`, optional `flags` | The agent made a tool call that fits every given field.                                                    |
| `tool_not_called`     | the same                                                            | The agent made no such call.                                                                               |
| `judge`               | `rubric`                                                            | Not 0 or 1. A model scores the final answer against the rubric.                                            |
| `decision`            | `question`, and `expect` or `options`                               | Not 0 or 1. A decision model gives each allowed answer a probability, and the score is the expected value. |

In every harness, "loaded a skill" means that the agent called the harness's skill tool with that skill's name, or that any tool call pointed at `skills/<name>/SKILL.md`.

`timeoutSeconds` defaults to 600. `maxTurns` has no default, and only Claude Code has a flag for it. The time limit alone bounds the other harnesses.

A prompt can start with any character. One that starts with a dash reaches the agent as the prompt and is not read as a flag of the harness.

The agent must not be able to tell that its answer is being measured. Write the prompt as a plain request, and keep these words out of the prompt and out of every file name under `workspace/`: `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, `arena`. Do not ask the agent which skills it used. The checks read that from its tool calls. The rubric stays in `case.json`, which the agent's workspace never holds. A plugin is loaded from where it is on disk, so the agent can see that path, and the cases too when they are inside the plugin's folder.

### Tool checks

`kind` says what the tool does, with the same word in every harness. Use it so that a case works in each harness.

| Kind       | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `shell`    | Ran a command.                                                       |
| `read`     | Read a file.                                                         |
| `write`    | Created or replaced a file.                                          |
| `edit`     | Changed part of a file, or deleted one.                              |
| `search`   | Searched or listed files.                                            |
| `web`      | Fetched a page or searched the web.                                  |
| `skill`    | Called the harness's skill tool.                                     |
| `subagent` | Started another agent.                                               |
| `other`    | Any tool the harness's adapter has no kind for, such as an MCP tool. |

`name` is a regular expression for the harness's own tool name, for example `^Bash$` in Claude Code. A check with `name` works in one harness only, so prefer `kind`. `inputMatches` is a regular expression for the call's input, written as JSON. `flags` applies to both expressions.

```json
{ "type": "tool_not_called", "kind": "shell", "inputMatches": "git push" }
```

Harnesses do not split work the same way. One harness has a search tool, and another runs `grep` through its shell tool, so `tool_called` with `"kind": "search"` can score 0 for an agent that did search. Tool calls that a subagent made count in the harnesses whose stream includes them (seen in Claude Code).

### Judged checks

A `judge` check asks a model how well the final answer meets the `rubric`, which is plain text that says what a good answer does. Use it for a quality that no pattern can find, such as whether a restatement keeps the meaning.

- The judge is one more harness run, so it works in each harness. It runs with nothing loaded, in a new home directory and an empty workspace, with a limit of two turns where the harness has a turn limit.
- The judge's prompt holds the case's prompt, the final answer, and the rubric. It does not hold the subject, the ref, a path, or the harness that produced the answer, so the judge cannot favor A or B.
- The judge must reply with one JSON object, `{"reason": "...", "score": 0.7}`. The scale is 0 for an answer that meets none of the rubric, 0.5 for about half, and 1 for all of it. A score outside 0 to 1 is rejected, not clamped.
- An unusable reply is asked for once more. After two unusable replies the check has no score and the run is invalid.
- `results.json` holds the judge's reason for each check, and the judge's duration, tokens, and cost for each run apart from the run's own.

A judge is a model, so its score moves. Measured with one small model as agent and judge on one case of the [magic](https://github.com/PhillipChaffee/magic) skills: six runs of an unchanged subject gave judged scores from 0.6 to 0.9, and four scorings of one fixed answer differed by 0.10 to 0.25. Use at least three reps, write a rubric with separate countable points, and name a stronger model with `--judge-model` when the differences you look for are small.

### Decision checks

A `decision` check asks a decision model a question about the final answer. A decision model writes no text. It returns a calibrated probability for each answer you allow, so you set what each answer is worth and the score is computed from the probabilities. Use it, like a `judge` check, for a quality that no pattern can find. The difference is that no model writes the score.

```json
{ "type": "decision", "question": "Does the answer avoid engineering jargon?", "expect": "yes" }
{ "type": "decision", "question": "Did the agent ask before deleting files?", "expect": "no" }
{
  "type": "decision",
  "question": "How well does the answer keep the original meaning?",
  "options": { "fully": 1, "mostly": 0.7, "partly": 0.3, "not at all": 0 }
}
```

A check takes exactly one of `expect` and `options`.

| Field     | Value                                                              | Check score                                             |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `expect`  | `"yes"`                                                            | P(yes)                                                  |
| `expect`  | `"no"`                                                             | 1 - P(yes)                                              |
| `options` | An object of at least two answers, each with a number from 0 to 1. | The sum, over the answers, of probability times number. |

An example: the model returns P(yes) = 0.9 for the first check above, so its score is 0.90. For the third check it returns `fully` 0.5, `mostly` 0.3, `partly` 0.1, and `not at all` 0.1, so its score is 0.5 × 1 + 0.3 × 0.7 + 0.1 × 0.3 + 0.1 × 0 = 0.74.

- **Configuration.** Name the model with `--decision-model <id>` or `decisionModel` in the [config file](commands.md#config-file). There is no default model. The API key comes from the `BASETEN_API_KEY` environment variable and from nowhere else. It is never read from the config file and never printed or written to the output directory. A suite that has a decision check and no model or no key stops with exit code 2 before any run starts.
- **Provider.** The client speaks Baseten's System One API, which serves [bison-1](https://huggingface.co/baselabs/bison-1) as `decision-models/baseten-bison-latest` and the other models in Baseten's [decision models](https://docs.baseten.co/inference/model-apis/decision-models) list. `--decision-url <url>` or `decisionUrl` names the base URL of another endpoint that speaks the same API, such as a deployment of your own. The request goes to `<url>/v1/systemone`.
- **One request for each run.** Every decision check of a case is one question of the same request. An `expect` check is sent as a yes/no question, and an `options` check as a choice among the option names. Write option names that say what they mean, because the model sees only the name.
- **What the model sees.** The request holds the case's prompt and the final answer, in `<task>` and `<answer>` tags, and the questions. It does not hold the subject, the ref, a path, or the harness that produced the answer, so the model cannot favor A or B.
- **Unusable replies.** A probability that is missing or is not a number from 0 to 1 is a failure of the model, and so are probabilities that do not add up to 1 over the allowed answers. A provider may round each probability to 6 decimals, so the sum may differ from 1 by 0.0000005 for each allowed answer: three options may add up to 0.999999 or 1.000001. A model that keeps real probability back, for example for an "I don't know" answer, is outside that limit. Nothing is filled in or scaled. A failed request, a response that is not 2xx, and a request that takes more than 60 seconds count the same. `--decision-timeout <seconds>` or `decisionTimeout` changes that limit. Raise it for a deployment of your own that starts cold, which can take a minute. The request is sent once more. After two failures no decision check of the run has a score, and the run is invalid.
- **Records.** `results.json` holds each decision check's score and `probabilities`, and for each run the number of requests with their duration and tokens, apart from the run's own. The API reports tokens and no cost, so the report shows no cost for the decision model.
- **The agent and the key.** When the suite has a decision check, `BASETEN_API_KEY` is removed from the environment of every harness process. An agent whose own model provider reads that variable cannot run in the same suite.
