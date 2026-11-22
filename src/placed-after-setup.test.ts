import path from "node:path";
import { expect, test } from "vitest";
import claudeCode from "./harnesses/claude-code.js";
import type { Harness } from "./harnesses/shared.js";
import { session } from "./session.js";
import { script, skillsFolder } from "./testing/plant.js";
import { asProcess, sandbox } from "./testing/sandbox.js";

test("skill copies that an adapter finds after its setup are placed, and the agent's changes to them are seen", async () => {
  const box = sandbox();
  script(box, "run", {
    turns: [
      [
        {
          call: {
            name: "Bash",
            input: { command: "echo x > $CONFIG_DIR/skills/foo/new.txt" },
            exec: true,
          },
        },
        { final: "done" },
      ],
    ],
  });
  const mine = skillsFolder(box, "mine", { foo: "# foo\n" });
  // The adapter's invocation declares no copies; its hook finds them once setup has run.
  const harness: Harness = {
    ...claudeCode,
    invocation: (input) => ({
      ...claudeCode.invocation(input),
      placed: {},
    }),
    placedAfterSetup: ({ home }) => ({
      foo: path.join(home, ".claude/skills/foo"),
    }),
  };
  const { value } = await asProcess({ env: box.env, cwd: box.root }, () =>
    session(
      {
        harness,
        bin: String(box.env["SKILL_EVALS_BIN_CLAUDE_CODE"]),
        subject: {
          kind: "skills",
          dir: mine,
          skills: ["foo"],
          skillDirs: { foo: path.join(mine, "foo") },
        },
        prompt: "hi",
        timeoutSeconds: 30,
      },
      (ran) => ran,
    ),
  );
  expect(Object.keys(value.placed ?? {})).toEqual(["foo"]);
  expect(value.placedChanges?.created).toEqual(["foo/new.txt"]);
});
