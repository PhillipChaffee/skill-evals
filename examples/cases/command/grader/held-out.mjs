import console from "node:console";
import process from "node:process";

// Runs after the agent exits. The agent never sees this file: it is not in the workspace.
const { parse } = await import(
  `${process.env.SKILL_EVALS_WORKSPACE}/src/parse.mjs`
);

const cases = [
  ["1,2", [1, 2]],
  ["10", [10]],
  ["0.5,-3", [0.5, -3]],
];
for (const [input, expected] of cases) {
  const got = JSON.stringify(parse(input));
  if (got !== JSON.stringify(expected)) {
    console.error(`parse(${JSON.stringify(input)}) gave ${got}`);
    process.exit(1);
  }
}
console.log(`ok ${String(cases.length)} held-out cases`);
