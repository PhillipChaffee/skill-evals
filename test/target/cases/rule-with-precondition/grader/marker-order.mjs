import fs from "node:fs";
import path from "node:path";
import console from "node:console";
import process from "node:process";

// The final reply must come after the agent saw the marker file. The agent's own tool results are the evidence, read
// from the transcript, and the marker must still be there when the run ends.
const events = JSON.parse(
  fs.readFileSync(process.env.SKILL_EVALS_TRANSCRIPT ?? "", "utf8"),
);
const marker = path.join(
  process.env.SKILL_EVALS_WORKSPACE ?? "",
  "build/done.flag",
);
if (!fs.existsSync(marker)) {
  console.error("build/done.flag does not exist");
  process.exit(1);
}
const main = events.filter((event) => event.agent?.id === "main");
const final = main.findLast((event) => event.type === "text" && event.text);
if (!final) {
  console.error("the agent never replied");
  process.exit(1);
}
const seen = main.find(
  (event) =>
    event.type === "tool_result" &&
    /done\.flag|build ok/.test(event.output ?? ""),
);
if (!seen) {
  console.error("no tool result shows the marker file");
  process.exit(1);
}
if (seen.index > final.index) {
  console.error(
    `the reply (event ${String(final.index)}) came before the marker was seen (event ${String(seen.index)})`,
  );
  process.exit(1);
}
console.log(
  `ok: the marker was seen at event ${String(seen.index)}, the reply came at event ${String(final.index)}`,
);
