// The DispatchTable idiom is owned by @suss/ir-core and reaches here
// through @suss/behavioral-ir, which this package already depends on.
// Re-exported under the name the fuzzer's modules already import.

export { type DispatchTable, dispatchByType } from "@suss/behavioral-ir";
