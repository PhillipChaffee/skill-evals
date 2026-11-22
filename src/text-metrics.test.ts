import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { sandbox } from "./testing/sandbox.js";

const grader = path.resolve(
  import.meta.dirname,
  "../examples/graders/text-metrics.mjs",
);

/**
 * Writes a text, runs the grader on it, and reports what it did.
 * @param text - The content of the text file.
 * @param flags - The flags of the grader.
 * @returns The exit code, standard output and standard error.
 */
function metrics(text: string, flags: string[] = []) {
  const box = sandbox();
  const file = box.write("text.md", text);
  box.write(BANNED_FILE, "Delve\n\nrich tapestry\n");
  const ran = spawnSync(process.execPath, [grader, file, ...flags], {
    cwd: box.root,
    encoding: "utf8",
  });
  return { status: ran.status, stdout: ran.stdout.trim(), stderr: ran.stderr };
}

const words = (count: number): string => Array(count).fill("word").join(" ");
const OK = "ok";
const BANNED_FILE = "banned.txt";
const WORDS = "--max-sentence-words";
const STRIP = "--strip-code";
const TEN = `${WORDS}=10`;
const MAX_40 = `${WORDS}=40`;
const PERCENTILE = "--percentile";
const MAX_5 = `${WORDS}=5`;
const MAX_2 = `${WORDS}=2`;
const BANNED = ["--banned", BANNED_FILE];

test("text-metrics flags a 41-word sentence at --max-sentence-words 40", () => {
  const text = `Short one. ${words(41)}. Another short one.`;
  const ran = metrics(text, [MAX_40]);
  expect(ran.status).toBe(1);
  expect(ran.stdout.split("\n")).toHaveLength(1);
  expect(ran.stdout).toMatch(
    /^sentence 2 has 41 words, above the maximum of 40: "word word/,
  );
  const fits = metrics(`${words(40)}. Short.`, [MAX_40]);
  expect(fits).toMatchObject({ status: 0, stdout: OK });
});

test("text-metrics splits at . ! ? followed by whitespace or the end, and nothing else", () => {
  const ran = metrics("Is it? Yes! e.g. this 3.14 works.", [MAX_2]);
  // "Is it?" 2, "Yes!" 1, "e.g." 1, "this 3.14 works." 3.
  expect(ran.stdout).toMatch(/^sentence 4 has 3 words/);
  expect(ran.stdout.split("\n")).toHaveLength(1);
});

test("text-metrics --percentile lets a few long sentences pass", () => {
  const nine = Array(9).fill("Short one.").join(" ");
  const text = `${nine} ${words(50)}.`;
  const flags = [TEN];
  expect(metrics(text, flags).status).toBe(1);
  expect(metrics(text, [...flags, PERCENTILE, "90"])).toMatchObject({
    status: 0,
    stdout: OK,
  });
  const tight = metrics(text, [...flags, PERCENTILE, "100"]);
  expect(tight.status).toBe(1);
  expect(tight.stdout).toBe(
    "percentile 100 of sentence length is 50 words, above the maximum of 10",
  );
  expect(metrics(text, [...flags, PERCENTILE, "0"]).status).toBe(0);
});

test("text-metrics --banned matches case-insensitively on whole words", () => {
  const ran = metrics(
    "We DELVE into it. A Rich\n  Tapestry, and delve again. Delved is fine.",
    BANNED,
  );
  expect(ran.status).toBe(1);
  expect(ran.stdout.split("\n")).toEqual([
    'banned phrase "Delve" appears 2 times',
    'banned phrase "rich tapestry" appears 1 time',
  ]);
  expect(metrics("Delving and tapestries are fine.", BANNED).stdout).toBe("ok");
});

test("text-metrics --strip-code ignores fenced and inline code", () => {
  const text = [
    "Plain text.",
    "```js",
    `// ${words(60)}. delve`,
    "```",
    `Inline \`delve ${words(60)}.\` is code too.`,
  ].join("\n");
  const flags = [TEN, ...BANNED];
  expect(metrics(text, flags).status).toBe(1);
  expect(metrics(text, [...flags, STRIP])).toMatchObject({
    status: 0,
    stdout: OK,
  });
  // A fence that is never closed runs to the end.
  expect(metrics("Fine.\n~~~\ndelve", [...BANNED, STRIP]).stdout).toBe("ok");
});

test("text-metrics exits 2 for a wrong command line", () => {
  expect(metrics("", [MAX_5])).toMatchObject({ status: 1, stdout: "no text" });
  const box = sandbox();
  const file = box.write("t.md", "x.");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [grader, ...args], { encoding: "utf8" });
  const cases: [string[], RegExp][] = [
    [[], /takes exactly one file/],
    [[file, PERCENTILE, "50"], /--percentile needs --max-sentence-words/],
    [[file, MAX_5, PERCENTILE, "101"], /from 0 to 100/],
    [[file, WORDS, "many"], /needs a number/],
    [[file, "--max-sentence-words=-1"], /may not be negative/],
    [[file, "--nope"], /nope/],
    [[path.join(box.root, "missing.md")], /cannot read the text file/],
    [
      [file, "--banned", path.join(box.root, "missing.txt")],
      /cannot read the banned phrases file/,
    ],
  ];
  for (const [args, message] of cases) {
    const ran = run(...args);
    expect(ran.status, args.join(" ")).toBe(2);
    expect(ran.stderr).toMatch(message);
    expect(ran.stdout).toBe("");
  }
  expect(fs.existsSync(file)).toBe(true);
});

test("text-metrics treats an empty text, or one that is only code, as a violation unless --allow-empty", () => {
  for (const text of ["", "  \n", "```\ncode only.\n```\n"]) {
    expect(metrics(text, [STRIP])).toMatchObject({
      status: 1,
      stdout: "no text",
    });
    expect(metrics(text, [STRIP, "--allow-empty"])).toMatchObject({
      status: 0,
      stdout: OK,
    });
  }
  expect(metrics("", [])).toMatchObject({ status: 1, stdout: "no text" });
});

test("text-metrics takes the percentile rank exactly: p 7 of 100 sentences is the 7th", () => {
  const text = `${Array(7).fill("Hi.").join(" ")} ${Array(93)
    .fill(`${words(50)}.`)
    .join(" ")}`;
  expect(metrics(text, [TEN, PERCENTILE, "7"])).toMatchObject({
    status: 0,
    stdout: OK,
  });
  expect(metrics(text, [TEN, PERCENTILE, "8"]).status).toBe(1);
});

test("text-metrics ends a sentence at a mark followed by closing punctuation", () => {
  const ran = metrics('(Done now.) Said "go home!" Then *stop.* End_ [x?] ok', [
    MAX_2,
  ]);
  // Sentences: "(Done now.)", 'Said "go home!"' (3 words), "Then *stop.*", "End_ [x?]", "ok".
  expect(ran.stdout).toMatch(/^sentence 2 has 3 words/);
  expect(ran.stdout.split("\n")).toHaveLength(1);
});

test("text-metrics closes a fence with a longer one, and an unclosed fence eats the rest", () => {
  const long = `Keep it.\n\n\`\`\`\n${words(60)}.\n\`\`\`\`\`\nAnd this.\n`;
  expect(metrics(long, [MAX_5, STRIP])).toMatchObject({
    status: 0,
    stdout: OK,
  });
  const open = `Keep it.\n\`\`\`\n${words(60)}.\n`;
  expect(metrics(open, [MAX_5, STRIP])).toMatchObject({
    status: 0,
    stdout: OK,
  });
  expect(metrics(open, [MAX_5]).status).toBe(1);
});

test("text-metrics matches banned phrases after NFC, and a combining mark is part of a word", () => {
  const box = sandbox();
  box.write("b.txt", "caf\u00e9\ndelve\n");
  const file = box.write("t.md", "A cafe\u0301 and delve\u0301 here. Delve.");
  const ran = spawnSync(process.execPath, [grader, file, "--banned", "b.txt"], {
    cwd: box.root,
    encoding: "utf8",
  });
  expect(ran.stdout.trim().split("\n")).toEqual([
    'banned phrase "café" appears 1 time',
    'banned phrase "delve" appears 1 time',
  ]);
});
