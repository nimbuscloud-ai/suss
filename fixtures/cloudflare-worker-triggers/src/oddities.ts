// An event that is not a trigger, a listener with no handler, and keys
// whose values are not functions make no unit. The event name kept in a
// const is read, so that listener is one.

addEventListener("install", () => {});
// @ts-expect-error a registration with no handler
addEventListener("fetch");
const eventName = "fetch";
addEventListener(eventName, () => {});

export default {
  fetch: 42,
  [Symbol.iterator]: 1,
  queue: undefined,
};
