#!/usr/bin/env node
// Stands in for a harness binary behind the Claude Code adapter: no model, and a Claude Code shaped stream.
// - Given the judge's prompt, it is the judge: it appends its prompt and model, and the names of its environment variables, to `prompts.jsonl` in `judge/` of $FAKE_DIR
//   and replies with the next unused entry of `replies.json` there.
// - Given --plugin-dir, it behaves as `behavior.json` in that directory says (a plugin without one is plain).
// - Given a script in `scripts/` of $FAKE_DIR that fits the run (see `FakeScript` in src/testing/plant.ts), it plays
//   that transcript instead of the behaviour below. Turn n of the script answers the n-th prompt of a session.
// - It lists the skills installed in its config directory at startup, unless `hide-skills` exists in $FAKE_DIR, and loads
//   each one that the prompt names.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const flag = (name) =>
  process.argv.includes(name)
    ? process.argv[process.argv.indexOf(name) + 1]
    : null;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const finish = (result, costUsd) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: costUsd,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 50,
    },
  });

const prompt = process.argv[process.argv.indexOf("--") + 1];
const pluginDir = flag("--plugin-dir");

if (prompt.startsWith("Grade one answer")) {
  const dir = path.join(process.env.FAKE_DIR ?? "", "judge");
  const replies = JSON.parse(
    fs.readFileSync(path.join(dir, "replies.json"), "utf8"),
  );
  const log = path.join(dir, "prompts.jsonl");
  const asked = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").length
    : 0;
  fs.appendFileSync(
    log,
    `${JSON.stringify({ prompt, model: flag("--model"), pluginDir, env: Object.keys(process.env) })}\n`,
  );
  emit({ type: "system", subtype: "init", plugins: [], skills: [] });
  finish(replies[asked], 0.002);
  process.exit(0);
}

/**
 * Finds the first script, by file name, that fits this run.
 * @returns The script and its file's name, or null when none fits.
 */
function matchingScript() {
  const dir =
    process.env.FAKE_DIR && path.join(process.env.FAKE_DIR, "scripts");
  if (!dir || !fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir).sort()) {
    let found;
    try {
      found = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`fake script ${file}: ${error.message}`, {
        cause: error,
      });
    }
    const { prompt: wanted, plugin } = found.match ?? {};
    if (
      (wanted === undefined || prompt.includes(wanted)) &&
      (plugin === undefined || plugin === Boolean(pluginDir))
    ) {
      return { found, file };
    }
  }
  return null;
}

/**
 * Counts the prompts this session has had. The count lives in the run's own config directory, which a run's turns
 * share and no other run sees.
 * @param file - The script's file name.
 * @returns The index of this prompt, from 0.
 */
function turnIndex(file) {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const counter = path.join(dir, `.fake-turn-${file}`);
  const turn = fs.existsSync(counter)
    ? Number(fs.readFileSync(counter, "utf8"))
    : 0;
  fs.writeFileSync(counter, String(turn + 1));
  return turn;
}

/**
 * Plays one turn of a script as a stream.
 * @param steps - The turn's steps.
 * @param turn - The index of the turn, which keeps ids unique across a session.
 */
function play(steps, turn) {
  let count = 0;
  let final = "";
  const id = (kind) => `${kind}_${turn}_${count++}`;
  const assistant = (content, parent) =>
    emit({
      type: "assistant",
      message: { id: id("msg"), role: "assistant", content },
      parent_tool_use_id: parent,
    });
  const toolResult = (use, content, isError, parent) =>
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: use,
            content,
            is_error: isError,
          },
        ],
      },
      parent_tool_use_id: parent,
    });
  // Makes a call's tool_use block, and returns what to do once it has been announced: run it, and report the result.
  const prepare = ({ name, input, output = "", exec, write }) => {
    const use = id("toolu");
    return {
      block: { type: "tool_use", id: use, name, input },
      settle: (parent) => {
        if (write) {
          fs.mkdirSync(path.dirname(path.resolve(write.path)), {
            recursive: true,
          });
          fs.writeFileSync(write.path, write.content);
        }
        if (!exec) return toolResult(use, output, false, parent);
        // The sandbox's PATH holds node and git only, so a command also gets the system's.
        const ran = spawnSync("sh", ["-c", `(${input.command}\n) 2>&1`], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${process.env.PATH}:/usr/local/bin:/usr/bin:/bin`,
          },
        });
        return toolResult(use, ran.stdout, ran.status !== 0, parent);
      },
    };
  };
  const step = (one, parent) => {
    if ("text" in one) {
      assistant([{ type: "text", text: one.text }], parent);
      final = one.text;
    } else if ("call" in one) {
      const { block, settle } = prepare(one.call);
      assistant([block], parent);
      settle(parent);
    } else if ("parallel" in one) {
      const prepared = one.parallel.map((each) => {
        if (!("call" in each)) {
          throw new Error(
            `parallel takes call steps only, got ${JSON.stringify(each)}`,
          );
        }
        return prepare(each.call);
      });
      assistant(
        prepared.map(({ block }) => block),
        parent,
      );
      for (const { settle } of prepared) settle(parent);
    } else if ("agent" in one) {
      const { type, prompt: task, steps: inner } = one.agent;
      const { block, settle } = prepare({
        name: "Agent",
        input: { subagent_type: type, prompt: task },
      });
      assistant([block], parent);
      for (const each of inner) step(each, block.id);
      settle(parent);
    } else if ("hook" in one) {
      const { event, command, exit, context = "" } = one.hook;
      emit({
        type: "system",
        subtype: "hook_response",
        hook_event: event,
        hook_name: command,
        exit_code: exit,
        output: context,
        outcome: exit === 0 ? "success" : "error",
      });
    } else if ("fail" in one) {
      throw new Error(one.fail);
    } else {
      final = one.final;
    }
  };
  try {
    for (const one of steps) step(one, null);
  } catch (error) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: error.message,
    });
    return;
  }
  finish(final);
}

const played = matchingScript();
const behaviorFile = pluginDir && path.join(pluginDir, "behavior.json");
const behavior =
  behaviorFile && fs.existsSync(behaviorFile)
    ? JSON.parse(fs.readFileSync(behaviorFile, "utf8"))
    : { name: "plain" };
const skillsDir = path.join(process.env.CLAUDE_CONFIG_DIR, "skills");
const installed = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir).sort()
  : [];

emit({
  type: "system",
  subtype: "init",
  plugins: pluginDir
    ? [{ name: "plugin", path: behavior.ghost ? "/nowhere/else" : pluginDir }]
    : [],
  skills: fs.existsSync(path.join(process.env.FAKE_DIR ?? "", "hide-skills"))
    ? []
    : installed,
  ...played?.found.init,
});
if (played) {
  const turn = turnIndex(played.file);
  play(played.found.turns[turn] ?? [], turn);
  process.exit(0);
}
const used = [
  ...(behavior.skill ? [`plugin:${behavior.skill}`] : []),
  ...installed.filter((name) => prompt.includes(name)),
];
for (const skill of used) {
  emit({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Skill", input: { skill } }],
    },
  });
}

fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/summary.txt", `summary by ${behavior.name}\n`);

const credentialsFile = path.join(
  process.env.CLAUDE_CONFIG_DIR,
  ".credentials.json",
);
const seen = {
  seed: fs.existsSync("notes.txt")
    ? fs.readFileSync("notes.txt", "utf8").trim()
    : "missing",
  leaks: Object.entries(process.env).filter(([key, value]) =>
    /skill.evals/i.test(`${key}=${value}`),
  ).length,
  home: process.env.HOME,
  cwd: process.cwd(),
  prompt,
  model: flag("--model"),
  credentials: fs.existsSync(credentialsFile)
    ? fs.readFileSync(credentialsFile, "utf8")
    : null,
  skills: Object.fromEntries(
    installed.map((name) => [
      name,
      fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8"),
    ]),
  ),
};
finish(behavior.answer ?? JSON.stringify(seen), behavior.costUsd);
