---
name: writing-skill-evals
description: Use when writing, extending, or debugging eval cases for an agent skill or plugin with skill-evals, when deciding what checks or pass bar a skill needs, or when a skill-evals report shows scores that do not move, a check stuck at 0 or full marks on both sides, or a judged score that swings between runs.
---

# Writing skill evals

## Overview

A case you have not run is a guess. Cases written from the skill's text alone look right and still contain checks that pass without the skill, checks that fail with it for reasons unrelated to it, and a pass bar the skill cannot reach.

**Core principle:** write a few cases, run them with and without the skill, and keep only what the run shows to be measuring the skill.

`skill-evals` is this repository's tool. Its `README.md` is the reference for the case format, every check type, and every flag. This skill is the method.

## The loop

1. **Read the skill** and list what an agent does differently because of it. Each item is a candidate check. Separate two questions: does the skill load when it should, and does the work come out right.
2. **Draft 3 to 5 cases** in `evals/cases/<id>/` with the recipe below.
3. **Run a pilot** against no skills, three runs each, on the model the skill will be used with. Whether a skill loads depends on the model:

   ```bash
   npx skill-evals run --a none --b <skills folder or plugin> --reps 3 --model <id>
   ```

4. **Read the report row by row**, then open the saved answers (`<out>/<harness>/<case>/a1.final.md`, `b1.final.md`) for every check the table below sends you to. The report says what happened. Only the answers say why.
5. **Fix, drop, or reweight** each check, then rerun every case you changed. A score you recomputed by hand after changing a check is not a result: only report numbers the tool printed, with A and B taken from the same run.
6. **Set the pass bar last**, from the scores the skill reached in the pilot. Then report what the pilot found, including what it found wrong with the skill.

## Case recipe

- **Prompt.** What a user would type, with the situation the skill is for and no mention of the skill. Never name the skill or tell the agent to use it: that measures obedience, not the skill.
- **One case where the skill must not load.** A request close to the skill's subject that it should leave alone, checked with `skill_not_loaded`.
- **Check the artifact, not the chat.** Ask for the result in a file and use `file_matches`. A pattern on the whole answer also matches the agent's commentary around the result.
- **Outcome checks carry the weight.** `skill_loaded` is 0 without the skill by construction, so it widens the gap without showing that the skill helped. Give it weight 1 and the outcome checks more.
- **Judged checks.** Use `judge` or `decision` only for what a pattern cannot see. Write the rubric as countable points. Prefer `decision` when a decision model is configured: its score for a fixed answer does not move. A judged or decision check sees only the final answer in the chat, never a file the agent wrote.
- **Workspace.** Each run starts in an empty home with no git identity and no tools configured. Put what the task needs in the case's `workspace/` folder.
- **Hidden purpose.** Keep `eval`, `test`, `judge`, `score`, `rubric`, `compare`, `benchmark`, and `candidate` out of the prompt and out of workspace file names.
- **The negative case scores full marks on both sides.** That is its job, and it lifts both suite scores by the same amount. Give it a low `weight` and its own `minScore` of 1.

## Reading the pilot

A is without the skill, B is with it.

| What the report shows                         | What it means                                                                                             | What to do                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A low, B high                                 | The check measures the skill.                                                                             | Keep it.                                                                                                                                                       |
| A full, B full                                | The agent does this anyway.                                                                               | Drop it or set its weight low. It raises both scores and hides the gap.                                                                                        |
| A zero, B zero                                | The check is wrong, or something outside the skill decides the result.                                    | Read `b1.final.md`. Fix the check if it matched the wrong text. If the agent really did it despite the skill, keep the check and report it as a skill failure. |
| `skill_loaded` on B below full                | The skill did not trigger on that prompt.                                                                 | Do not rewrite the prompt to force it. This is a finding about the skill's description. Report it.                                                             |
| B below A on a judged check                   | Usually noise. A general model's judged score moves by 0.1 to 0.25 on an unchanged answer.                | Compare the two answers yourself. Raise `--reps`, use a stronger `--judge-model`, or replace the check with a `decision` check or a pattern.                   |
| A fails a check for a reason you did not plan | Your own machine or harness setup shaped the answer, for example an instruction it adds to every session. | Read `a1.final.md`. Say so in the report: the gap on that check will differ on another machine.                                                                |
| Every check of a case equal on A and B        | The skill never took part, or the setup broke.                                                            | Check `skill_loaded` and the answers before blaming the skill.                                                                                                 |

## Setting the bar

- Use `--min-score` for the suite and `minScore` in `case.json` for a case that must not regress.
- Set each a little under what B reached across the pilot's runs. A bar picked before a run is a guess, and a skill that works can miss it.
- Three runs separate a large effect. For a small one, raise `--reps` before you trust the difference.

## Common mistakes

| Mistake                                                     | Fix                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Handing over cases that were never run                      | Run the pilot. If you cannot, say that the cases are unverified and which checks may not hold. |
| Expecting `skill_loaded` to be full because the prompt fits | Measure it. A fitting prompt often does not trigger the skill.                                 |
| Deleting a check because it fails with the skill            | First find out why. A real failure of the skill is the result you were looking for.            |
| Many checks the agent passes without the skill              | They make the score high and the skill invisible. Cut them.                                    |
| Reading a judged score difference from one or two runs      | Treat it as noise until more runs agree.                                                       |
| Putting the skill's name in the prompt                      | Describe the situation and let the skill trigger on its own.                                   |

## What to report

Give the cases, the pilot report, the bar and where it came from, and two lists: what the pilot showed about the skill (it did not load on some prompts, the agent ignored a rule), and which checks you dropped or changed and why.
