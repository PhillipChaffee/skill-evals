/**
 * Runs jobs with at most `limit` in flight at once.
 * @param jobs - The jobs, each started by calling it.
 * @param limit - The most jobs in flight at once, a positive integer.
 * @param gate - Asked before each job starts. After it answers "stop", no new job starts and the jobs in flight finish.
 * @returns What each job resolved with, in the order of `jobs` whatever the order they finished in; a job that never
 *   started is undefined. When a job throws, no new job starts, and the first error is thrown once every job in flight
 *   has settled, so nothing is left running and every cleanup has run.
 */
export async function pool<T>(
  jobs: (() => Promise<T>)[],
  limit: number,
  gate: () => "go" | "stop",
): Promise<(T | undefined)[]> {
  const results = new Array<T | undefined>(jobs.length).fill(undefined);
  const errors: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (errors.length === 0 && next < jobs.length && gate() === "go") {
      const index = next++;
      try {
        results[index] = await (jobs[index] as () => Promise<T>)();
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, worker),
  );
  if (errors.length > 0) throw errors[0];
  return results;
}
