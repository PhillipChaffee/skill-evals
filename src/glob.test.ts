import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  baseGlobOf,
  expandGlob,
  globToRegExp,
  literalGlob,
  literalPrefix,
  mayNameVariant,
  mayReachVariantOf,
} from "./glob.js";
import { sandbox } from "./testing/sandbox.js";

const TABLE: [string, string, boolean][] = [
  ["src/**/*.ts", "src/a/b.ts", true],
  ["src/**/*.ts", "src/b.ts", true],
  ["src/*.ts", "src/a/b.ts", false],
  ["src/*.ts", "src/b.ts", true],
  ["{a,b}/x", "b/x", true],
  ["{a,b}/x", "c/x", false],
  ["routing-*", "routing-1", true],
  ["routing-*", "other-1", false],
  ["*", "a/b", false],
  ["*", "ab", true],
  ["a?c", "abc", true],
  ["a?c", "a/c", false],
  ["a.b", "axb", false],
  ["secret/**", "secret/deep/file", true],
  ["a(b)+[c]", "a(b)+[c]", true],
  ["a\\*b", "a*b", true],
  ["a\\*b", "axb", false],
];

test.each(TABLE)("the glob %s against %s gives %s", (glob, text, expected) => {
  expect(globToRegExp(glob).test(text)).toBe(expected);
});

test("a glob with an unclosed brace is a usage error that names it", () => {
  expect(() => globToRegExp("{a,b")).toThrow(/unclosed "\{" in the glob \{a,b/);
});

test("literalGlob makes a glob that matches only that path", () => {
  const path = "we*ird/{x},?";
  expect(globToRegExp(literalGlob(path)).test(path)).toBe(true);
  expect(globToRegExp(literalGlob(path)).test("weXird/x,Y")).toBe(false);
});

test("expandGlob lists sorted relative paths and never follows a link", () => {
  const box = sandbox();
  box.write("tree/b/two.ts", "");
  box.write("tree/a/one.ts", "");
  box.write("tree/a/note.md", "");
  box.write("outside/secret.ts", "");
  fs.symlinkSync(
    path.join(box.root, "outside"),
    path.join(box.root, "tree/link"),
  );
  const tree = path.join(box.root, "tree");
  expect(expandGlob(tree, "**/*.ts")).toEqual(["a/one.ts", "b/two.ts"]);
  expect(expandGlob(tree, "link")).toEqual(["link"]);
  expect(expandGlob(tree, "link/**")).toEqual([]);
});

test("expandGlob past its limit throws a usage error that names the glob", () => {
  const box = sandbox();
  for (const name of ["a", "b", "c"]) box.write(`tree/${name}.txt`, "");
  const tree = path.join(box.root, "tree");
  expect(expandGlob(tree, "*.txt", 3)).toHaveLength(3);
  expect(() => expandGlob(tree, "*.txt", 2)).toThrow(
    'the glob "*.txt" matches more than 2 paths',
  );
});

test("literalPrefix stops where glob syntax starts", () => {
  expect(literalPrefix("to*")).toBe("to");
  expect(literalPrefix("*lite")).toBe("");
  expect(literalPrefix("a?b")).toBe("a");
  expect(literalPrefix("a{b,c}")).toBe("a");
  expect(literalPrefix(String.raw`a\*b*`)).toBe("a");
  expect(literalPrefix("plain")).toBe("plain");
});

test("a loose glob reaches the variants of a case only when its prefix lies within the path", () => {
  expect(mayNameVariant("to*")).toBe(true);
  expect(mayNameVariant("to*@x")).toBe(false);
  expect(mayNameVariant("plain")).toBe(false);
  expect(mayReachVariantOf("to*", "tool")).toBe(true);
  expect(mayReachVariantOf("to*", "other")).toBe(false);
  expect(mayReachVariantOf("*lite", "other")).toBe(true);
  expect(mayReachVariantOf("tool", "tool")).toBe(false);
});

test("baseGlobOf keeps the part before the first @ unless it is empty or splits a brace", () => {
  expect(baseGlobOf("good@v1")).toBe("good");
  expect(baseGlobOf("plain")).toBe("plain");
  expect(baseGlobOf("@v")).toBe("**");
  expect(baseGlobOf("{a@x,b}")).toBe("**");
});
