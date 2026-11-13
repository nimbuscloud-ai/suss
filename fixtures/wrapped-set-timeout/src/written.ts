// Timers whose callback is wrapped in a cast or is undefined, and one
// whose callee is wrapped in parentheses. None of these changes what
// runs.

function flush(): void {
  console.log("flushed");
}

export function castCallback(): void {
  setTimeout((() => flush()) as () => void, 5);
}

export function undefinedCallback(): void {
  setTimeout(undefined, 5);
}

export function parenthesizedCallee(): void {
  (setTimeout)(() => flush(), 5);
}
