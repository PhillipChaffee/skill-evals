---
title: Decision checks
description: How a decision check is scored, and how to set up the decision model.
---

A `decision` check asks a decision model a question about the final answer. A decision model writes no text. It returns a calibrated probability for each answer you allow, so you set what each answer is worth and the score is computed from the probabilities. Use it, like a `judge` check, for a quality that no pattern can find. The difference is that no model writes the score.

```json
{
  "checks": [
    {
      "type": "decision",
      "question": "Does the answer avoid engineering jargon?",
      "expect": "yes"
    },
    {
      "type": "decision",
      "question": "Did the agent ask before deleting files?",
      "expect": "no"
    },
    {
      "type": "decision",
      "question": "How well does the answer keep the original meaning?",
      "options": { "fully": 1, "mostly": 0.7, "partly": 0.3, "not at all": 0 }
    }
  ]
}
```

A check takes exactly one of `expect` and `options`.

| Field     | Value                                                              | Check score                                             |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `expect`  | `"yes"`                                                            | P(yes)                                                  |
| `expect`  | `"no"`                                                             | 1 - P(yes)                                              |
| `options` | An object of at least two answers, each with a number from 0 to 1. | The sum, over the answers, of probability times number. |

An example: the model returns P(yes) = 0.9 for the first check above, so its score is 0.90. For the third check it returns `fully` 0.5, `mostly` 0.3, `partly` 0.1, and `not at all` 0.1, so its score is 0.5 × 1 + 0.3 × 0.7 + 0.1 × 0.3 + 0.1 × 0 = 0.74.

- **Configuration.** Name the model with `--decision-model <id>` or `decisionModel` in the [config file](../reference/config.md). There is no default model. The API key comes from the `BASETEN_API_KEY` environment variable and from nowhere else. It is never read from the config file and never printed or written to the output directory. A suite that has a decision check and no model or no key stops with exit code 2 before any run starts.
- **Provider.** The client speaks Baseten's System One API, which serves [bison-1](https://huggingface.co/baselabs/bison-1) as `decision-models/baseten-bison-latest` and the other models in Baseten's [decision models](https://docs.baseten.co/inference/model-apis/decision-models) list. `--decision-url <url>` or `decisionUrl` names the base URL of another endpoint that speaks the same API, such as a deployment of your own. The request goes to `<url>/v1/systemone`.
- **One request for each run.** Every decision check of a case is one question of the same request. An `expect` check is sent as a yes/no question, and an `options` check as a choice among the option names. Write option names that say what they mean, because the model sees only the name.
- **What the model sees.** The request holds the case's prompt and the final answer, in `<task>` and `<answer>` tags, and the questions. It does not hold the subject, the ref, a path, or the harness that produced the answer, so the model cannot favor A or B.
- **Unusable replies.** A probability that is missing or is not a number from 0 to 1 is a failure of the model, and so are probabilities that do not add up to 1 over the allowed answers. A provider may round each probability to 6 decimals, so the sum may differ from 1 by 0.0000005 for each allowed answer: three options may add up to 0.999999 or 1.000001. A model that keeps real probability back, for example for an "I don't know" answer, is outside that limit. Nothing is filled in or scaled. A failed request, a response that is not 2xx, and a request that takes more than 60 seconds count the same. `--decision-timeout <seconds>` or `decisionTimeout` changes that limit. Raise it for a deployment of your own that starts cold, which can take a minute. The request is sent once more. After two failures no decision check of the run has a score, and the run is invalid.
- **Records.** `results.json` holds each decision check's score and `probabilities`, and for each run the number of requests with their duration and tokens, apart from the run's own. The API reports tokens and no cost, so the report shows no cost for the decision model.
- **The agent and the key.** When the suite has a decision check, `BASETEN_API_KEY` is removed from the environment of every harness process. An agent whose own model provider reads that variable cannot run in the same suite.
