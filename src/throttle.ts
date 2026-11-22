/**
 * Limits how often an action runs.
 * @param act - What to run with the latest value.
 * @param intervalMs - The least time between two runs of `act`, counted from when this was called.
 * @param now - The clock in milliseconds. Default: the system clock.
 * @returns A function that runs `act` when `intervalMs` has passed since `act` last ran, and otherwise does nothing.
 */
export function throttled<T>(
  act: (value: T) => void,
  intervalMs: number,
  now: () => number = Date.now,
): (value: T) => void {
  let last = now();
  return (value) => {
    if (now() - last < intervalMs) return;
    last = now();
    act(value);
  };
}
