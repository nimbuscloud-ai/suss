// bodyShapesMatch is a shared comparison primitive owned by
// @suss/ir-core (both the behavioural and intent checkers compare
// TypeShapes and must agree). Re-exported here so the checker's
// internal consumers that import it from this module are unaffected by
// the move.
export { bodyShapesMatch } from "@suss/ir-core";
