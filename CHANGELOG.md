# Changelog

## Unreleased

- A `decision` check asks a decision model a question about the final answer. The case sets what each allowed answer is worth, the model returns a probability for each answer, and the check's score is the expected value. All decision checks of a case go out in one request for each run.
- `--decision-model` and `--decision-url`, and `decisionModel` and `decisionUrl` in the config file, set the model and its endpoint. The client speaks Baseten's System One API and reads its key from `BASETEN_API_KEY`. It was written from the API's documentation and has not yet called the real API.

## 0.1.0

The first release. The runner comes from the `evals/` folder of [magic](https://github.com/PhillipChaffee/magic), where it scored that one set of skills.

- Run it in any project. The project is the git repository that holds the working directory, and the cases default to `evals/cases` in it.
- Score a plugin, a plain folder of skills, or `none`, which loads no skills and is the baseline for a comparison.
- Set defaults in an optional `skill-evals.config.json`.
- Use it from code with `evaluate`, `loadCases`, and `HARNESSES`.
- A prompt that starts with a dash reaches the agent in every harness.
- Windows is not supported.
- The package is written in TypeScript. It ships compiled JavaScript and type declarations, and still has no dependencies.
