# Changelog

## 0.1.0

The first release. The runner comes from the `evals/` folder of [magic](https://github.com/PhillipChaffee/magic), where it scored that one set of skills.

- Run it in any project. The project is the git repository that holds the working directory, and the cases default to `evals/cases` in it.
- Score a plugin, a plain folder of skills, or `none`, which loads no skills and is the baseline for a comparison.
- Set defaults in an optional `skill-evals.config.json`.
- Use it from code with `evaluate`, `loadCases`, and `HARNESSES`.
- A prompt that starts with a dash reaches the agent in every harness.
- Windows is not supported.
