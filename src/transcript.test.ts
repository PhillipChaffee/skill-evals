import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { exec } from "./exec.js";
import type { TranscriptEvent } from "./harnesses/shared.js";
import {
  callsOf,
  event,
  failedCalls,
  forRecord,
  numbered,
  writeTranscript,
} from "./transcript.js";
import { scoreGraded } from "./testing/graded.js";
import { exec as agentRuns } from "./testing/runs.js";
import { parseText } from "./testing/streams.js";
import { sandbox } from "./testing/sandbox.js";

const MAIN = { id: "main", type: "main", parent: null, depth: 0 };
const KIB = 1024;
const MIB = KIB * KIB;
const TRANSCRIPT_FILE = "claude-code/restate/subject1.transcript.json";

const call = (name: string, callId: string): TranscriptEvent =>
  event({ role: "assistant", type: "tool_call", name, kind: "shell", callId });

test("event fills the main agent, no turn, the first user turn and the byte size of its text", () => {
  expect(event({ role: "assistant", type: "text", text: "héllo" }, 3)).toEqual({
    index: 3,
    turn: null,
    userTurn: 0,
    role: "assistant",
    type: "text",
    agent: MAIN,
    text: "héllo",
    bytes: 6,
  });
  const result = event({ role: "tool", type: "tool_result", output: "ab" });
  expect(result.bytes).toBe(2);
  expect(event({ role: "assistant", type: "tool_call" }).bytes).toBeUndefined();
});

test("numbered gives each event its position and a result the name and kind of the call it answers", () => {
  const listed = numbered([
    {
      role: "assistant",
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      callId: "a",
    },
    { role: "tool", type: "tool_result", callId: "a", output: "x" },
    { role: "tool", type: "tool_result", callId: "zzz", output: "y" },
    { role: "tool", type: "tool_result", output: "z" },
  ]);
  expect(listed.map((e) => e.index)).toEqual([0, 1, 2, 3]);
  expect(listed.map((e) => [e.name, e.kind])).toEqual([
    ["Bash", "shell"],
    ["Bash", "shell"],
    [undefined, undefined],
    [undefined, undefined],
  ]);
});

test("callsOf lists the tool calls with a turn only where the event has one", () => {
  const events = numbered([
    { role: "assistant", type: "text", text: "hi" },
    {
      role: "assistant",
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      input: { command: "ls" },
      turn: 2,
    },
    { role: "assistant", type: "tool_call", kind: "read", input: 1 },
    { role: "assistant", type: "tool_call", name: "x" },
  ]);
  expect(callsOf(events)).toEqual([
    { name: "Bash", kind: "shell", input: { command: "ls" }, turn: 2 },
    { name: "", kind: "read", input: 1 },
    { name: "x", kind: "other", input: undefined },
  ]);
});

test("failedCalls names the position of each call whose own result was an error", () => {
  const events = numbered([
    call("Skill", "a"),
    call("Bash", "b"),
    { role: "tool", type: "tool_result", callId: "b", isError: true },
    { role: "tool", type: "tool_result", callId: "a", isError: false },
    { role: "tool", type: "tool_result", callId: "none", isError: true },
    { role: "tool", type: "tool_result", isError: true },
    { role: "assistant", type: "tool_call", name: "x" },
  ]);
  expect([...failedCalls(events)]).toEqual([1]);
});

test("a binary tool output is decoded with replacement and its decoded byte size recorded", async () => {
  const produce = `process.stdout.write(Buffer.concat([Buffer.from('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"f'), Buffer.from([0xff, 0xfe]), Buffer.from('o"}]}}\\n')]))`;
  const ran = await exec("node", ["-e", produce], {
    cwd: os.tmpdir(),
    env: { PATH: process.env["PATH"] },
    timeoutSeconds: 20,
  });
  const parsed = parseText("claude-code", ran.stdout);
  const [result] = parsed.transcript;
  expect(result?.output).toBe("f��o");
  // Each replacement character is three bytes in UTF-8: the size is that of the text as decoded, not of the raw bytes.
  expect(result?.bytes).toBe(1 + 3 + 3 + 1);
});

test("a 2 MB output is whole on disk and cut in forRecord, with its original size", () => {
  const big = "é".repeat(MIB);
  const events = numbered([
    { role: "tool", type: "tool_result", callId: "a", output: big },
    { role: "assistant", type: "text", text: "short" },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = writeTranscript(path.join(dir, "run1"), events);
  expect(file).toBe(path.join(dir, "run1.transcript.json"));
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as TranscriptEvent[];
  expect(onDisk[0]?.output).toHaveLength(MIB);
  expect(onDisk[0]?.truncated).toBeUndefined();

  const cut = forRecord(events, 1001);
  // The cut falls inside a two-byte character, so it steps back to the character before.
  expect(cut[0]?.output).toBe("é".repeat(500));
  expect(cut[0]).toMatchObject({ truncated: true, bytes: 2 * MIB });
  expect(cut[1]).toEqual(events[1]);
  expect(events[0]?.output).toHaveLength(MIB);
  const defaulted = forRecord(events);
  expect(Buffer.byteLength(defaulted[0]?.output ?? "")).toBeLessThanOrEqual(
    20_000,
  );
  const exact = forRecord(events, 2 * MIB);
  expect(exact[0]?.truncated).toBeUndefined();
});

test("forRecord cuts text as well as output", () => {
  const [one] = forRecord(
    numbered([{ role: "assistant", type: "text", text: "abcdef" }]),
    3,
  );
  expect(one).toMatchObject({ text: "abc", truncated: true, bytes: 6 });
});

test("the transcript file is written beside the stream file, relative in the record, absolute in the command", async () => {
  const box = sandbox();
  const ran = await scoreGraded(box, {
    checks: [
      {
        type: "command",
        run: `node -e "const f = process.env.SKILL_EVALS_TRANSCRIPT; const ok = require('node:path').isAbsolute(f) && require('node:fs').readFileSync(f, 'utf8').includes('boom'); process.exit(ok ? 0 : 1)"`,
      },
    ],
    agent: [{ text: "starting" }, agentRuns("echo boom; exit 1")],
  });
  const [record] = ran.results?.records ?? [];
  expect(record?.checks[0]?.score).toBe(1);
  expect(record?.transcriptFile).toBe(TRANSCRIPT_FILE);
  const file = path.join(ran.out, TRANSCRIPT_FILE);
  expect(fs.existsSync(file.replace(".transcript.json", ".stream.jsonl"))).toBe(
    true,
  );
  const events = JSON.parse(fs.readFileSync(file, "utf8")) as TranscriptEvent[];
  expect(events.map((e) => [e.type, e.text ?? e.output])).toEqual([
    ["text", "starting"],
    ["tool_call", undefined],
    ["tool_result", "boom\n"],
  ]);
  expect(events[2]).toMatchObject({ isError: true, kind: "shell" });
  // The results file keeps the inputs of the calls and no output.
  expect(JSON.stringify(record?.toolCalls)).not.toContain("boom\\n");
  expect(Object.keys(record?.toolCalls[0] ?? {}).sort()).toEqual([
    "index",
    "input",
    "kind",
    "name",
    "turn",
  ]);
});

test("a skill load whose tool result was an error is unresolved, where the adapter has tool outputs", async () => {
  const skill = (output: string, isError: boolean) => ({
    call: { name: "Skill", input: { skill: "bro" }, output, isError },
  });
  const run = async (isError: boolean) => {
    const ran = await scoreGraded(sandbox(), {
      checks: [{ type: "skill_loaded", skill: "bro", resolved: true }],
      agent: [skill("Launching skill: bro", isError)],
    });
    return ran.results?.records[0]?.skillEvents[0]?.resolved;
  };
  expect(await run(false)).toBe(true);
  expect(await run(true)).toBe(false);
});
