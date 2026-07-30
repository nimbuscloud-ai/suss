// @suss/differential — differential fuzzer for extraction fidelity.
//
// Internal tool (never published). Generates handler-shaped programs,
// runs the real extraction pipeline over them, executes the same body
// against request batteries, and adjudicates the summary's claims
// against observed behavior. See differential.test.ts for the
// properties and corpus.test.ts for the permanent counterexample corpus.

export * from "./differential.js";
export * from "./execute.js";
export * from "./extract.js";
export * from "./generators.js";
export * from "./interpret.js";
export * from "./program.js";
export * from "./requests.js";
export * from "./target.js";
