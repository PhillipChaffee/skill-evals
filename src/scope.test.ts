import { expect, test, vi } from "vitest";
import { onDispose, runCleanups } from "./scope.js";

test("a cleanup that throws at exit is reported and does not stop the cleanups after it", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let ran = false;
  const first = onDispose(() => {
    throw new Error("EACCES: no");
  });
  const second = onDispose(() => {
    ran = true;
  });
  runCleanups();
  first();
  second();
  expect(ran).toBe(true);
  expect(error).toHaveBeenCalledWith("skill-evals: cleanup failed: EACCES: no");
  error.mockRestore();
});
