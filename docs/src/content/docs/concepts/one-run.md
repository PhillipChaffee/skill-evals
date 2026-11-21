---
title: What one run does
description: Every step of a run, and when a run does not count.
---

1. Creates a new, empty home directory and a new workspace directory. Their names (`home-*`, `proj-*`, `kit-*`) say nothing about why they exist.
2. Copies the case's `workspace/` folder into the workspace.
3. Copies the harness's credential files from your real home into the new home, so a login keeps working. Nothing else is copied.
4. Starts the harness with `HOME` and the XDG directories pointed at the new home, and with the subject loaded as [Subjects](subjects.md) describes. The harness does not get the environment variables that name this tool: the ones that start with `SKILL_EVALS_` or `npm_`, and `_`. When the suite has a decision check, the harness does not get the decision model's API key either.
5. Turns the harness's event stream into one run record and scores the case's checks. A judged check starts one more harness run, described under [Judged checks](../guides/judged-checks.md). The decision checks of the case go to the decision model in one request, described under [Decision checks](../guides/decision-checks.md).
6. Deletes both directories.

A run counts only when it is valid. A run is invalid when it failed (harness error, time limit), when the harness reported what it loaded and the subject was not in it, or when a judged check or a decision check got no usable score. Invalid runs are listed under the table, left out of every number, and make the command exit 1.

"The subject was not in it" means that a plugin's directory is not among the loaded plugins, or that a skill of a skills folder is not among the listed skills. Only Claude Code reports either. In the other four harnesses a subject that did not load shows up as missing skill loads, not as an invalid run.
