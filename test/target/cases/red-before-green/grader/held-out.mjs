import console from "node:console";
import process from "node:process";

// Held-out check: more inputs than the suite in the workspace has. A `command` check runs it from the workspace.
const { add } = await import(`${process.env.SKILL_EVALS_WORKSPACE}/src/add.js`);

const cases = [
  [[10, 20], 30],
  [[-4, -6], -10],
  [[0, 0], 0],
  [[7, -7], 0],
  [[1.5, 2.5], 4],
];
const wrong = cases.filter(([args, want]) => add(...args) !== want);
for (const [args, want] of wrong) {
  console.error(`add(${args.join(", ")}) is not ${String(want)}`);
}
if (wrong.length > 0) process.exit(1);
console.log(`ok ${String(cases.length)} held-out cases`);
