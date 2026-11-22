import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { seededLoad } from "./testing/history-case.js";

const HISTORY = "seeded/history.json";
const SESSIONS = "seeded/sessions";
const ONE = [{ role: "user", text: "hi" }];

test("history.json stays inside the case, outside grader/, and is a file of JSON", () => {
  const { box, dir, load } = seededLoad({ history: ONE });
  const file = path.join(dir, HISTORY);
  const outside = path.join(box.root, "outside.json");
  fs.writeFileSync(outside, JSON.stringify([{ role: "user", text: "leaked" }]));
  fs.rmSync(file);
  fs.symlinkSync(outside, file);
  expect(() => load()).toThrow(/history\.json: must stay inside the case/);
  fs.rmSync(file);
  fs.symlinkSync(path.join(box.root, "nowhere.json"), file);
  expect(() => load()).toThrow(/is a link to nothing/);
  // A link to a file of the case itself is the case's own file; one into grader/ is not.
  fs.rmSync(file);
  fs.writeFileSync(path.join(dir, "seeded/own.json"), JSON.stringify(ONE));
  fs.symlinkSync("own.json", file);
  expect(load()?.history).toEqual(ONE);
  fs.mkdirSync(path.join(dir, "seeded/grader"));
  fs.writeFileSync(path.join(dir, "seeded/grader/h.json"), "[]");
  fs.rmSync(file);
  fs.symlinkSync("grader/h.json", file);
  expect(() => load()).toThrow(/is in grader\//);
  fs.rmSync(file);
  fs.writeFileSync(file, "{ nope");
  expect(() => load()).toThrow(/history\.json: /);
  fs.rmSync(file);
  fs.mkdirSync(path.join(dir, "seeded/dir.json"));
  fs.symlinkSync("dir.json", file);
  expect(() => load()).toThrow(/is not a file/);
});

test("sessions/ stays inside the case and holds sessions.json", () => {
  const session = { id: "a", startedAt: "2026-01-01", messages: ONE };
  const { box, dir, load } = seededLoad({ sessions: [session] });
  const folder = path.join(dir, SESSIONS);
  const elsewhere = path.join(box.root, "elsewhere");
  fs.symlinkSync(elsewhere, path.join(folder, "leak"));
  expect(() => load()).toThrow(
    /sessions: leak is a link to .*links outside the sessions directory/s,
  );
  fs.rmSync(path.join(folder, "leak"));
  fs.rmSync(path.join(folder, "sessions.json"));
  expect(() => load()).toThrow(/needs sessions\.json/);
  fs.rmSync(folder, { recursive: true });
  fs.symlinkSync(elsewhere, folder);
  expect(() => load()).toThrow(/is a link to nothing/);
  fs.rmSync(folder);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, folder);
  expect(() => load()).toThrow(/sessions: must stay inside the case/);
  fs.rmSync(folder);
  fs.writeFileSync(folder, "");
  expect(() => load()).toThrow(/sessions: must be a directory/);
});
