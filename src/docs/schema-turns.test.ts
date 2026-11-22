import { expect, test } from "vitest";
import { validate } from "../testing/schema-validator.js";
import { caseSchema } from "./schema.js";

const doc = caseSchema();
const problems = (value: unknown): string[] => validate(value, doc, doc);
const first = { prompt: "turn-1.md" };

test("a case of turns alone is valid, and a reply turn has a condition and a prompt", () => {
  expect(problems({ turns: [first] })).toEqual([]);
  const reply = (more: unknown) =>
    problems({ turns: [first, { reply: more }] });
  expect(reply({ whenAsked: "which", prompt: "answer.md" })).toEqual([]);
  expect(reply({ prompt: "answer.md" })).not.toEqual([]);
  expect(reply({ whenAsked: "which" })).not.toEqual([]);
  expect(reply({ whenAsked: "which", prompt: "a.md", more: 1 })).not.toEqual(
    [],
  );
  expect(
    problems({
      turns: [
        first,
        { reply: { whenAsked: "w", prompt: "a.md" }, prompt: "b" },
      ],
    }),
  ).not.toEqual([]);
});
