/** One kind of case that `init` writes: the prompt and the case file, with placeholders to replace. */
export interface Template {
  /** The text of `prompt.md`. */
  prompt: string;
  /** The content of `case.json`. */
  case: object;
  /** What to do next, besides editing the two files; shown after the files are written. */
  next?: string;
}

const SKILL = "your-skill";
const CHECKED = "Replace every placeholder, then run `skill-evals validate`.";

/**
 * The kinds of case `init` can start from, each a case that loads and passes `validate`. The placeholders are
 * `your-skill`, the prompt and the rubric: edit them before the first run.
 */
export const TEMPLATES: Record<string, Template> = {
  trigger: {
    prompt: "Write here a request that only your skill answers well.\n",
    case: {
      kind: "trigger",
      description: "The skill is loaded for a request that is its job.",
      targets: [SKILL],
      checks: [{ type: "skill_loaded", skill: SKILL }],
    },
    next: CHECKED,
  },
  negative: {
    prompt:
      "Write here a request that is close to the skill but not its job.\n",
    case: {
      kind: "negative",
      description:
        "The skill stays unloaded for a request that is not its job.",
      targets: [SKILL],
      checks: [{ type: "skill_not_loaded", skill: SKILL }],
    },
    next: CHECKED,
  },
  behaviour: {
    prompt: "Write here the task the skill changes how the agent does.\n",
    case: {
      kind: "behaviour",
      description: "The agent works the way the skill says.",
      targets: [SKILL],
      checks: [
        { type: "skill_loaded", skill: SKILL },
        { type: "tool_called", kind: "shell", inputMatches: "your-command" },
        { type: "file_exists", path: "result.md" },
      ],
    },
    next: CHECKED,
  },
  pressure: {
    prompt:
      "Write here the task, with the pressure that tempts the agent to skip the skill: a deadline, or a user who says it is not needed.\n",
    case: {
      kind: "pressure",
      description: "The agent still follows the skill under pressure.",
      targets: [SKILL],
      guard: true,
      checks: [
        { type: "skill_loaded", skill: SKILL },
        {
          type: "tool_not_called",
          kind: "shell",
          inputMatches: "git push --force",
        },
      ],
    },
    next: CHECKED,
  },
  agent: {
    prompt: "Write here a task that the skill hands to a subagent.\n",
    case: {
      kind: "agent",
      description: "The agent dispatches the subagent the skill names.",
      targets: [SKILL],
      checks: [{ type: "agent_dispatched", agent: "your-agent", min: 1 }],
    },
    next: `${CHECKED} agent_dispatched needs a harness that reports subagents; elsewhere the case is not applicable.`,
  },
  outcome: {
    prompt: "Write here a task whose result is a file or a passing command.\n",
    case: {
      kind: "outcome",
      description: "The task ends in the state the skill is for.",
      targets: [SKILL],
      checks: [
        { type: "file_exists", path: "result.md", created: true },
        { type: "command", run: "test -s result.md" },
      ],
    },
    next: `${CHECKED} Put what the agent starts with in a workspace/ folder beside prompt.md.`,
  },
  prose: {
    prompt: "Write here a task whose answer is a piece of writing.\n",
    case: {
      kind: "prose",
      description: "The writing is a file, free of the phrases the skill bans.",
      targets: [SKILL],
      checks: [
        { type: "file_exists", path: "answer.md" },
        {
          type: "file_lacks",
          path: "answer.md",
          pattern: "\\b(delve|tapestry)\\b",
          flags: "i",
        },
        {
          type: "judge",
          rubric:
            "The writing answers the task in plain words and makes no claim it cannot support.",
        },
      ],
    },
    next: `${CHECKED} For sentence length, see examples/graders/text-metrics.mjs and the prose-checks guide.`,
  },
};
