// The project's own wrappers around the runtime's timers. The callback
// a caller hands one of these reaches setTimeout through a parameter.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(fn, ms);
}

export function every(fn: () => void, ms: number): () => void {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
}

export async function retry<T>(attempt: () => Promise<T>, times: number): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= times) {
        throw error;
      }
      await sleep(100 * tries);
    }
  }
}

export function debounce(fn: () => void, ms: number): () => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(handle);
    handle = setTimeout(() => {
      fn();
    }, ms);
  };
}
