// A project helper that shares React's hook name. It queues work for
// the page to run once it has loaded, and React never calls it.

const pending: Array<() => void> = [];

export function useEffect(run: () => void, _deps: unknown[]): void {
  pending.push(run);
}

export function flushPending(): void {
  for (const run of pending.splice(0)) {
    run();
  }
}
