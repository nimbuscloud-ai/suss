// Work handed to the runtime to run later. A callback written in place
// at the top of a function becomes a unit of its own.

function flush(): void {
  console.log("flushed");
}

export function scheduleFlush(): void {
  setTimeout(() => {
    console.log("flushing");
  }, 250);
  setTimeout(flush, 1000);
  setTimeout(function later() {
    flush();
  });
}

export function poll(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    console.info("polling");
  }, 5000);
}

export function soon(): void {
  setImmediate(() => {
    console.log("immediate");
  });
  queueMicrotask(() => {
    console.log("microtask");
  });
  process.nextTick(() => {
    console.log("tick");
  });
  process.nextTick(flush);
}

// A timer inside an arrow: the parent gets the schedule effect and no
// unit is made for the callback.
export function afterLoad(load: Promise<void>): Promise<void> {
  return load.then(() => {
    setTimeout(() => {
      console.log("loaded");
    }, 10);
  });
}

export function noCallback(): void {
  setTimeout(undefined as unknown as () => void, 5);
}
