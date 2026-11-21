import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { allChanged, diffSnapshots, snapshot } from "./snapshot.js";
import { sandbox } from "./testing/sandbox.js";

test("a snapshot hashes files and links, and diffSnapshots sorts what changed", () => {
  const box = sandbox();
  box.write("d/keep.txt", "same");
  box.write("d/edit.txt", "before");
  box.write("d/gone.txt", "bye");
  box.write("d/sub/deep.txt", "x");
  fs.symlinkSync("keep.txt", path.join(box.root, "d/link"));
  const dir = path.join(box.root, "d");
  const before = snapshot(dir);
  expect([...before.keys()].sort()).toEqual([
    "edit.txt",
    "gone.txt",
    "keep.txt",
    "link",
    "sub/deep.txt",
  ]);

  box.write("d/edit.txt", "after");
  box.write("d/new/file.txt", "n");
  fs.rmSync(path.join(dir, "gone.txt"));
  fs.rmSync(path.join(dir, "link"));
  fs.symlinkSync("edit.txt", path.join(dir, "link"));
  const changes = diffSnapshots(before, snapshot(dir));
  expect(changes).toEqual({
    created: ["new/file.txt"],
    modified: ["edit.txt", "link"],
    deleted: ["gone.txt"],
  });
  expect(allChanged(changes)).toEqual([
    "new/file.txt",
    "edit.txt",
    "link",
    "gone.txt",
  ]);
});

const LOCKED = "locked.txt";

test("a file that cannot be read is hashed as unreadable, and a skipped path is absent", () => {
  const box = sandbox();
  box.write("d/locked.txt", "secret");
  box.write("d/open.txt", "fine");
  box.write("d/skipped/a.txt", "a");
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: string) => {
    if (file.endsWith(LOCKED)) throw new Error("EACCES");
    return read(file);
  }) as typeof fs.readFileSync);
  const taken = snapshot(path.join(box.root, "d"), (rel) => rel === "skipped");
  vi.restoreAllMocks();
  expect([...taken.keys()].sort()).toEqual([LOCKED, "open.txt"]);
  expect(taken.get(LOCKED)).toBe("unreadable");
});

test("a directory that cannot be listed is one unreadable entry", () => {
  const box = sandbox();
  box.write("d/sub/a.txt", "a");
  const list = fs.readdirSync.bind(fs);
  vi.spyOn(fs, "readdirSync").mockImplementation(((dir: string) => {
    if (dir.endsWith("sub")) throw new Error("EACCES");
    return list(dir, { withFileTypes: true });
  }) as unknown as typeof fs.readdirSync);
  const taken = snapshot(path.join(box.root, "d"));
  vi.restoreAllMocks();
  expect([...taken.entries()]).toEqual([["sub", "unreadable"]]);
});

test("a socket is hashed as unreadable and never opened", async () => {
  const box = sandbox();
  box.write("d/a.txt", "a");
  const dir = path.join(box.root, "d");
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(path.join(dir, "sock"), resolve);
  });
  const taken = snapshot(dir);
  server.close();
  expect(taken.get("sock")).toBe("unreadable");
  expect(taken.get("a.txt")).toMatch(/^[0-9a-f]{64}$/);
});
