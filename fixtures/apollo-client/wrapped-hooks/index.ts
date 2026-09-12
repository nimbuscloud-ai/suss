// A barrel between the components and the hooks, which is what defeats
// a per-file import check.

export { useAppMutation, useAppQuery } from "./hooks.js";
export { useLegacyQuery } from "./legacyHooks.js";
