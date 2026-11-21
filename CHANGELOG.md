# Changelog

## Unreleased

- Releases are guarded. `scripts/release-plan.sh` refuses a version tag that does not match `package.json`, is not on `main`, has no changelog entry, or is not above the latest version on npm, and the `Release check` workflow runs the same guards on every pull request. The publish workflow also makes the GitHub release.

## 0.0.1

The first release. The runner comes from the `evals/` folder of [magic](https://github.com/PhillipChaffee/magic), where it scored that one set of skills.

- Run it in any project. The project is the git repository that holds the working directory, and the cases default to `evals/cases` in it.
- Score a plugin, a plain folder of skills, or `none`, which loads no skills and is the baseline for a comparison.
- Set defaults in an optional `skill-evals.config.json`.
- Use it from code with `evaluate`, `loadCases`, and `HARNESSES`.
- A prompt that starts with a dash reaches the agent in every harness.
- Windows is not supported.
- The package is written in TypeScript. It ships compiled JavaScript and type declarations, and still has no dependencies.

- A `decision` check asks a decision model a question about the final answer. The case sets what each allowed answer is worth, the model returns a probability for each answer, and the check's score is the expected value. All decision checks of a case go out in one request for each run.
- `--decision-model` and `--decision-url`, and `decisionModel` and `decisionUrl` in the config file, set the model and its endpoint. The client speaks Baseten's System One API and reads its key from `BASETEN_API_KEY`. It was written from the API's documentation. It has scored checks against bison-1 on a self-hosted deployment, and has not yet called Baseten's hosted API.
- `--decision-timeout <seconds>` and `decisionTimeout` in the config file set how long one request to the decision model may take. The default stays 60 seconds. A cold start of a self-hosted model can take that long.
- A decision reply whose probabilities were rounded to 6 decimals is accepted. The sum over the allowed answers may differ from 1 by 0.0000005 for each answer, where the limit was 0.000001 in total, which rejected three honest options that added up to 0.999999.
