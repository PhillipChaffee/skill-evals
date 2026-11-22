const CLAUDE_CODE = "claude-code";

// A config file that sets every key. The tests make sure that it has exactly the keys of CONFIG_KEYS, each with a
// value of the key's type, and that the tool accepts it.
export const EXAMPLE_CONFIG: Record<
  string,
  string | number | boolean | string[]
> = {
  cases: "evals/cases",
  harness: CLAUDE_CODE,
  reps: 3,
  jobs: 4,
  retries: 1,
  maxCost: 25,
  maxDuration: 90,
  model: "<model-id>",
  judgeHarness: CLAUDE_CODE,
  judgeModel: "<model-id>",
  judgeApi: "anthropic",
  judgeUrl: "<base-url>",
  judgeKeyVar: "ANTHROPIC_API_KEY",
  judgeTimeout: 120,
  judgeFallbacks: true,
  decisionModel: "<decision-model-id>",
  decisionUrl: "<base-url>",
  decisionTimeout: 60,
  minScore: 0.8,
  minDelta: 0.05,
  noise: "results/noise.json",
  seed: 1,
  maxInvalid: 0.1,
  report: ["md", "json"],
  maxJudgedWeightShare: 0.5,
  lenient: false,
  isolated: false,
  sandbox: false,
  historyMode: "preamble",
  keepWorkspaces: false,
  env: ["AWS_ENDPOINT_URL"],
  subjectExclude: ["evals/cases/**", "notes/**"],
  rules: "rules",
  instructionFile: "AGENTS.md",
};
