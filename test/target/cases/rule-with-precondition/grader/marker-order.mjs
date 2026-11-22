import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import process from "node:process";

// The final reply must come after a tool result that shows the line the finished build wrote. That line holds the time
// and the process id of the run, so no earlier reading of the script can quote it. The transcript is the evidence.
const events = JSON.parse(
  fs.readFileSync(process.env.SKILL_EVALS_TRANSCRIPT ?? "", "utf8"),
);
const file = path.join(
  process.env.SKILL_EVALS_WORKSPACE ?? "",
  "build/build-result",
);
if (!fs.existsSync(file)) {
  console.error("the build never finished");
  process.exit(1);
}
const token = fs.readFileSync(file, "utf8").trim();
const main = events.filter((event) => event.agent?.id === "main");
const final = main.findLast((event) => event.type === "text" && event.text);
if (!final) {
  console.error("the agent never replied");
  process.exit(1);
}
const seen = main.find(
  (event) =>
    event.type === "tool_result" && (event.output ?? "").includes(token),
);
if (!seen) {
  console.error("no tool result shows the line the build wrote");
  process.exit(1);
}
if (seen.index > final.index) {
  console.error(
    `the reply (event ${String(final.index)}) came before the build's line was seen (event ${String(seen.index)})`,
  );
  process.exit(1);
}
console.log(
  `ok: the line was seen at event ${String(seen.index)}, the reply came at event ${String(final.index)}`,
);
