import { expect, test } from "vitest";
import { post } from "./http.js";

const SECRET = "sk-secret-123";
const request = { headers: {}, body: "{}", timeoutMs: 1000, secret: SECRET };

/**
 * Sends a request that fails.
 * @param endpoint - The URL.
 * @returns The error that `post` threw.
 */
const failure = async (endpoint: string): Promise<Error> => {
  try {
    await post(endpoint, request);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the request did not fail");
};

test("a failed request hides the secret in its message and carries no cause", async () => {
  // A URL that does not parse makes fetch quote it, which here holds the secret.
  const failed = await failure(`not a url ${SECRET}`);
  expect(failed.message).toContain("[redacted]");
  expect(failed.message).not.toContain(SECRET);
  expect(failed.cause).toBeUndefined();
  const refused = await failure("http://127.0.0.1:1/");
  expect(refused.cause).toBeUndefined();
});
