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
export * from "./jsx/componentDifferential.js";
export * from "./jsx/componentExecute.js";
export * from "./jsx/componentGenerators.js";
export * from "./jsx/componentJudge.js";
export * from "./jsx/componentProgram.js";
export * from "./program.js";
export * from "./requests.js";
export * from "./shape/announceShape.js";
export * from "./shape/componentShape.js";
export * from "./shape/equivalence.js";
export * from "./shape/invariants.js";
export * from "./shape/knownBugs.js";
export * from "./shape/minimize.js";
export * from "./shape/shapeDifferential.js";
export * from "./shape/shapeGenerators.js";
export * from "./shape/shapeProgram.js";
export * from "./shape/shapeTargets.js";
export * from "./target.js";
