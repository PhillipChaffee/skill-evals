#!/usr/bin/env node
// Stands in for a harness binary behind the Claude Code adapter: no model, and a Claude Code shaped stream.
// - Given the judge's prompt, it is the judge: it appends its prompt and model, and the names of its environment variables, to `prompts.jsonl` in `judge/` of $FAKE_DIR
//   and replies with the next unused entry of `replies.json` there.
// - Given --plugin-dir, it behaves as `behavior.json` in that directory says (a plugin without one is plain).
// - Given a script in `scripts/` of $FAKE_DIR that fits the run (see `FakeScript` in src/testing/plant.ts), it plays
//   that transcript instead of the behaviour below. Turn n of the script answers the n-th prompt of a session.
// - A script's `exec` command sees the plugin directory as $PLUGIN_DIR, and a `write` path may start with it.
// - In a call's `input`, every string has `$PLUGIN_DIR` (the --plugin-dir) and `$CONFIG_DIR` (the run's config directory,
//   where the adapter places skill copies) replaced before the call is announced, so a script can address them.
// - Started with `--mode json` (the arguments of the Pi adapter) it is Pi-shaped instead: the prompt comes from standard
//   input, the plugin directory from `-e`, and the stream is Pi's (`tool_execution_start`, `turn_end`). It plays the
//   same scripts, for `text`, `final`, `call`, and `parallel` steps; it has no judge, no agents, and no hooks.
// - A script step `{ "limit": true }` ends the turn as Claude Code does at its own `--max-turns`: an `error_max_turns`
//   result with `is_error` true and no text, and exit code 1. The fake ignores `--max-turns` itself.
// - A step `{ "onStart": [1, 2], "step": <step> }` plays its `step` only on those starts of this script, counted from 1
//   across processes in `starts/` of $FAKE_DIR. A step `{ "crash": "text" }` writes the text to standard error and exits 1
//   with no result event, as a harness that dies does. A step `{ "hang": true }` never returns, so only a kill ends it.
// - A call step with `"denied": true` is listed in the result's `permission_denials` with its id, as a `-p` process lists a
//   question it cannot ask. A call to the question tool is an ordinary `call` step:
//   `{ "call": { "name": "AskUserQuestion", "input": { "questions": [{ "question": "..." }] }, "denied": true } }`.
// - A script's `costUsd` is the `total_cost_usd` of its result event; without it the result states no cost.
// - A script's `initOmit` names init fields to leave out, and `noInit` leaves the init event out.
// - A turn of a multi-turn case is another process of the same run (the same config directory): once a script has matched,
//   the later processes of that run play the same script, whatever their prompt says. Turn n answers the n-th prompt.
// - `--resume <id>` is how the Claude Code adapter continues a session. The fake reports `session_id` in its init and
//   result events: the id it was resumed with, else `fake-session-<pid>`. In a script's text, `$RESUMED` is that
//   `--resume` value ("" when absent). A script's `noSessionId` leaves the id out, as a harness that states none does; its `sessions` lists the id each
//   turn states in place of that one, and its `inits` lists fields of each turn's init event to replace.
// - A prompt of `/compact` is a compaction: it writes a `compact_boundary` system event and no assistant turn, and it does
//   not use up a script turn.
// - It reports the history it found (`foundHistory`): the count in the "Earlier in this conversation (N messages):" block of the
//   prompt (`preamble`), or the conversational lines of the session file that `--resume <id>` names, under
//   `projects/<cwd with every character but letters and digits as "-">/<id>.jsonl` of its config directory (`native`);
//   and the other session files it found there. In a script's text, `$HISTORY` is the message count and `$HISTORY_MODE`
//   the mode ("none" when it found none). Without a script the final text is JSON that has `history` and `sessions`.
// - It lists the skills installed in its config directory at startup, unless `hide-skills` exists in $FAKE_DIR, and loads
//   each one that the prompt names.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const flag = (name) =>
  process.argv.includes(name)
    ? process.argv[process.argv.indexOf(name) + 1]
    : null;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const resumed = flag("--resume");
// The id of this session: the one it was resumed with, or a new one. A script can leave it out.
let sessionId = resumed ?? `fake-session-${process.pid}`;
// The calls with `"denied": true`: the result lists them as `permission_denials`.
const denials = [];
const finish = (result, costUsd) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    ...(sessionId && { session_id: sessionId }),
    ...(denials.length > 0 && { permission_denials: denials }),
    result,
    total_cost_usd: costUsd,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 50,
    },
  });

// `--version` is a question about the executable, not a run: it is logged apart, and it never counts as a start.
// - FAKE_VERSION_LOG: a file that gets one line for each question.
// - FAKE_VERSION_FAIL: when set, the question fails with exit code 1 and no output.
if (process.argv.includes("--version")) {
  if (process.env.FAKE_VERSION_LOG) {
    fs.appendFileSync(process.env.FAKE_VERSION_LOG, "version\n");
  }
  if (process.env.FAKE_VERSION_FAIL) process.exit(1);
  process.stdout.write("fake-harness 9.9.9\nsecond line\n");
  process.exit(0);
}

// Every start is logged, so a test can tell that no harness ran.
if (process.env.FAKE_START_LOG) {
  fs.appendFileSync(process.env.FAKE_START_LOG, "start\n");
}

const piMode = flag("--mode") === "json";
const prompt = piMode
  ? fs.readFileSync(0, "utf8")
  : process.argv[process.argv.indexOf("--") + 1];
const pluginDir = piMode ? flag("-e") : flag("--plugin-dir");

if (!piMode && prompt.startsWith("Grade one answer")) {
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
    `${JSON.stringify({ prompt, model: flag("--model"), pluginDir, argv: process.argv.slice(2), env: Object.keys(process.env) })}\n`,
  );
  // `judge/init.json` replaces fields of the judge's init event, and its `omit` lists fields to leave out.
  const initFile = path.join(dir, "init.json");
  const { omit = [], ...more } = fs.existsSync(initFile)
    ? JSON.parse(fs.readFileSync(initFile, "utf8"))
    : {};
  const judgeInit = {
    type: "system",
    subtype: "init",
    plugins: [],
    skills: [],
    ...more,
  };
  for (const key of omit) delete judgeInit[key];
  emit(judgeInit);
  finish(replies[asked], 0.002);
  process.exit(0);
}

if (!piMode && prompt === "/compact") {
  emit({
    type: "system",
    subtype: "init",
    plugins: [],
    skills: [],
    session_id: sessionId,
  });
  emit({ type: "system", subtype: "compact_boundary", session_id: sessionId });
  finish("", undefined);
  process.exit(0);
}

/**
 * Finds the first script, by file name, that fits this run. A run that has played a script before, in an earlier
 * process, plays it again.
 * @returns The script and its file's name, or null when none fits.
 */
function matchingScript() {
  const dir =
    process.env.FAKE_DIR && path.join(process.env.FAKE_DIR, "scripts");
  if (!dir || !fs.existsSync(dir)) return null;
  const config =
    process.env.CLAUDE_CONFIG_DIR ?? process.env.PI_CODING_AGENT_DIR;
  const marker = config && path.join(config, ".fake-script");
  const chosen =
    marker && fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
  const found = chosen ? loadScript(dir, chosen) : firstScript(dir);
  if (found && marker && !chosen) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, found.file);
  }
  return found;
}

/**
 * Reads one script file.
 * @param dir - The scripts directory.
 * @param file - The script's file name.
 * @returns The script and its file's name.
 */
function loadScript(dir, file) {
  try {
    return {
      found: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")),
      file,
    };
  } catch (error) {
    throw new Error(`fake script ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Finds the first script, by file name, that fits this run's prompt.
 * @param dir - The scripts directory.
 * @returns The script and its file's name, or null when none fits.
 */
function firstScript(dir) {
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
 * Counts how many times this script has started, this start included. The count lives in $FAKE_DIR, which every start
 * of a sandbox shares.
 * @param file - The script's file name.
 * @returns The number of this start, from 1.
 */
function startNumber(file) {
  const dir = path.join(process.env.FAKE_DIR ?? "", "starts");
  fs.mkdirSync(dir, { recursive: true });
  const counter = path.join(dir, file);
  const started = fs.existsSync(counter)
    ? Number(fs.readFileSync(counter, "utf8"))
    : 0;
  fs.writeFileSync(counter, String(started + 1));
  return started + 1;
}

/**
 * Counts the prompts this session has had. The count lives in the run's own config directory, which a run's turns
 * share and no other run sees.
 * @param file - The script's file name.
 * @returns The index of this prompt, from 0.
 */
function turnIndex(file) {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const counter = path.join(dir, `.fake-turn-${file}`);
  const turn = fs.existsSync(counter)
    ? Number(fs.readFileSync(counter, "utf8"))
    : 0;
  fs.writeFileSync(counter, String(turn + 1));
  return turn;
}

/**
 * Finds the history that this run was given, in either mode, and the other sessions in the store.
 * @returns `{ mode, messages, lines, found }` for the history (`found` is whether a native session file is where Claude Code
 *   looks for the working directory's sessions) and `others`, the ids of the session files that are not the resumed one.
 */
function foundHistory() {
  const header = /^Earlier in this conversation \((\d+) messages\):/m.exec(
    prompt ?? "",
  );
  const config = process.env.CLAUDE_CONFIG_DIR ?? "";
  const root = path.join(config, "projects");
  const files = fs.existsSync(root)
    ? fs.readdirSync(root).flatMap((dir) =>
        fs
          .readdirSync(path.join(root, dir))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => ({ dir, id: name.slice(0, -".jsonl".length) })),
      )
    : [];
  const others = files
    .filter(({ id }) => id !== resumed)
    .map(({ id }) => id)
    .sort();
  if (header) {
    return {
      mode: "preamble",
      messages: Number(header[1]),
      lines: 0,
      found: false,
      others,
    };
  }
  const own = files.find(({ id }) => id === resumed);
  if (!own)
    return { mode: "none", messages: 0, lines: 0, found: false, others };
  const lines = fs
    .readFileSync(path.join(root, own.dir, `${resumed}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const spoken = lines.filter(
    ({ message }) =>
      message.role === "assistant" || typeof message.content === "string",
  );
  const here = path
    .join(root, fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"))
    .concat(path.sep);
  return {
    mode: "native",
    messages: spoken.length,
    lines: lines.length,
    found: path.join(root, own.dir).concat(path.sep) === here,
    others,
  };
}

/**
 * Replaces the placeholders of a script's call input, at any depth.
 * @param value - The input, or a part of it.
 * @returns The same shape with `$PLUGIN_DIR` and `$CONFIG_DIR` filled in.
 */
function expand(value) {
  if (typeof value === "string") {
    const config =
      process.env.CLAUDE_CONFIG_DIR ?? process.env.PI_CODING_AGENT_DIR ?? "";
    return value
      .replaceAll("$PLUGIN_DIR", pluginDir ?? "")
      .replaceAll("$CONFIG_DIR", config)
      .replaceAll("$RESUMED", resumed ?? "")
      .replaceAll("$HISTORY_MODE", history.mode)
      .replaceAll("$HISTORY", String(history.messages));
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, expand(each)]),
    );
  }
  return value;
}

/**
 * Does what a scripted call asks for in the workspace.
 * @param call - The call step's fields: its input, what it executes or writes, and `isError` for a result that fails without running anything.
 * @returns What the tool reports: its output text, and whether it failed.
 */
const perform = ({ input, output = "", exec, write, isError = false }) => {
  if (write) {
    // $PLUGIN_DIR stands for the --plugin-dir this run was given, so a script can write into the plugin.
    const target = write.path.replaceAll("$PLUGIN_DIR", pluginDir ?? "");
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, write.content);
  }
  if (!exec) return { content: output, isError };
  // The sandbox's PATH holds node and git only, so a command also gets the system's. Its output goes to a file, and the
  // run's own standard output is handed to it as descriptor 3, so a process it leaves in the background holds the
  // harness's pipe open as a real agent's would.
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "fake-out-")),
    "output",
  );
  const ran = spawnSync("sh", ["-c", `(${input.command}\n) >"$0" 2>&1`, file], {
    stdio: ["ignore", "ignore", "ignore", 1],
    env: {
      ...process.env,
      PLUGIN_DIR: pluginDir ?? "",
      PATH: `${process.env.PATH}:/usr/local/bin:/usr/bin:/bin`,
    },
  });
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return { content, isError: ran.status !== 0 };
};

/**
 * Plays one turn of a script as a stream.
 * @param steps - The turn's steps.
 * @param turn - The index of the turn, which keeps ids unique across a session.
 * @returns True when the turn ended at the CLI's turn limit, which exits with code 1.
 */
function play(steps, turn) {
  let count = 0;
  let final = "";
  const id = (kind) => `${kind}_${turn}_${count++}`;
  const assistant = (content, parent, usage) =>
    emit({
      type: "assistant",
      message: {
        id: id("msg"),
        role: "assistant",
        content,
        ...(usage && { usage }),
      },
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
  const prepare = (scripted) => {
    const call = { ...scripted, input: expand(scripted.input) };
    const use = id("toolu");
    // A denied call is listed in the result's `permission_denials`, as a `-p` process lists a question it cannot ask.
    if (call.denied) {
      denials.push({
        tool_name: call.name,
        tool_use_id: use,
        tool_input: call.input,
      });
    }
    return {
      block: { type: "tool_use", id: use, name: call.name, input: call.input },
      settle: (parent) => {
        const { content, isError } = perform(call);
        toolResult(use, content, isError, parent);
      },
    };
  };
  // An `Agent` call, with the steps that its child plays.
  const dispatch = ({ type, prompt: task, model, steps: inner }) => ({
    ...prepare({
      name: "Agent",
      input: { subagent_type: type, prompt: task, ...(model && { model }) },
    }),
    inner,
  });
  const step = (one, parent) => {
    if ("onStart" in one) {
      if (one.onStart.includes(startOf())) step(one.step, parent);
      return;
    }
    if ("text" in one) {
      assistant([{ type: "text", text: expand(one.text) }], parent, one.usage);
      final = expand(one.text);
    } else if ("call" in one) {
      const { block, settle } = prepare(one.call);
      assistant([block], parent);
      settle(parent);
    } else if ("parallel" in one) {
      const prepared = one.parallel.map((each) => {
        if ("agent" in each) return dispatch(each.agent);
        if (!("call" in each)) {
          throw new Error(
            `parallel takes call and agent steps only, got ${JSON.stringify(each)}`,
          );
        }
        return { ...prepare(each.call), inner: [] };
      });
      assistant(
        prepared.map(({ block }) => block),
        parent,
      );
      for (const { block, settle, inner } of prepared) {
        for (const each of inner) step(each, block.id);
        settle(parent);
      }
    } else if ("agent" in one) {
      const { block, settle, inner } = dispatch(one.agent);
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
    } else if ("crash" in one) {
      process.stderr.write(`${one.crash}\n`);
      process.exit(1);
    } else if ("hang" in one) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    } else if ("limit" in one) {
      limited = true;
    } else {
      final = expand(one.final);
    }
  };
  let limited = false;
  try {
    for (const one of steps) step(one, null);
  } catch (error) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      ...(sessionId && { session_id: sessionId }),
      result: error.message,
    });
    return false;
  }
  if (!limited) {
    finish(final, played.found.costUsd);
    return false;
  }
  // The CLI's own turn limit: an error result with no `result` text, and a non-zero exit.
  emit({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    ...(sessionId && { session_id: sessionId }),
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  return true;
}

/**
 * Plays one turn of a script as Pi's stream: each call is announced and run, and one `turn_end` closes the turn.
 * @param steps - The turn's steps.
 */
function playPi(steps) {
  let final = "";
  const call = (scripted) => {
    const one = { ...scripted, input: expand(scripted.input) };
    emit({
      type: "tool_execution_start",
      toolName: one.name,
      args: one.input,
    });
    perform(one);
  };
  // Pi states a message at its end, and again at the end of its turn.
  const turnEnd = (message) => {
    emit({ type: "turn_start" });
    emit({ type: "message_end", message });
    emit({ type: "turn_end", message });
  };
  try {
    for (const one of steps) {
      if ("text" in one) final = one.text;
      else if ("call" in one) call(one.call);
      else if ("parallel" in one)
        one.parallel.forEach((each) => call(each.call));
      else if ("final" in one) final = one.final;
      else if ("fail" in one) throw new Error(one.fail);
      else throw new Error(`pi mode does not play ${Object.keys(one)[0]}`);
    }
  } catch (error) {
    turnEnd({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: error.message,
    });
    return;
  }
  turnEnd({
    role: "assistant",
    content: [{ type: "text", text: final }],
    stopReason: "stop",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheWrite: 0,
      cost: { total: 0.001 },
    },
  });
}

const history = piMode
  ? { mode: "none", messages: 0, lines: 0, found: false, others: [] }
  : foundHistory();
const played = matchingScript();
if (played?.found.noSessionId) sessionId = null;
let startNo = null;
/**
 * Numbers this start of the matching script, once.
 * @returns The number, from 1.
 */
const startOf = () => (startNo ??= startNumber(played.file));
if (piMode) {
  if (played) {
    playPi(played.found.turns[turnIndex(played.file)] ?? []);
  } else {
    const seen = { prompt, cwd: process.cwd(), model: flag("--model") };
    playPi([{ final: JSON.stringify(seen) }]);
  }
  process.exit(0);
}
const behaviorFile = pluginDir && path.join(pluginDir, "behavior.json");
const behavior =
  behaviorFile && fs.existsSync(behaviorFile)
    ? JSON.parse(fs.readFileSync(behaviorFile, "utf8"))
    : { name: "plain" };
const skillsDir = path.join(process.env.CLAUDE_CONFIG_DIR, "skills");
const installed = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir).sort()
  : [];

// The turn of the script that this process plays, and what the script says of its session and its init event.
const turnNo = played ? turnIndex(played.file) : null;
if (played?.found.sessions?.[turnNo]) sessionId = played.found.sessions[turnNo];
const init = {
  type: "system",
  subtype: "init",
  ...(sessionId && { session_id: sessionId }),
  plugins: pluginDir
    ? [{ name: "plugin", path: behavior.ghost ? "/nowhere/else" : pluginDir }]
    : [],
  skills: fs.existsSync(path.join(process.env.FAKE_DIR ?? "", "hide-skills"))
    ? []
    : installed,
  ...played?.found.init,
  ...played?.found.inits?.[turnNo],
};
// A script can leave fields out of the init event, or the whole event.
for (const key of played?.found.initOmit ?? []) delete init[key];
if (!played?.found.noInit) emit(init);
// A script's `syncSkill` is a skill that an account syncs into the config directory during the run.
if (played?.found.syncSkill) {
  const dir = path.join(
    process.env.CLAUDE_CONFIG_DIR,
    "synced",
    "org",
    played.found.syncSkill,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "synced\n");
}
if (played) {
  const turn = turnNo;
  process.exit(play(played.found.turns[turn] ?? [], turn) ? 1 : 0);
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
  history: {
    mode: history.mode,
    messages: history.messages,
    lines: history.lines,
    found: history.found,
  },
  sessions: history.others,
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
