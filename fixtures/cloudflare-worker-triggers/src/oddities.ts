// Registrations the pack doesn't make a unit from: an event that is not
// a trigger, a listener with no handler, an event name kept in a const,
// and trigger keys whose values are not functions.

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
