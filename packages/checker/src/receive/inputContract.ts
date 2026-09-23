// The intent checker uses the read-set rule too and does not depend on
// this package, so the rule lives in @suss/behavioral-ir.

export {
  boundaryInputReads,
  type CarriesPayload,
  type ComparisonResult,
  carriesPayloadFor,
  checkReceivedInput,
  compareSupplied,
  formatPath,
  isTheMessageParameter,
  messageBodyReadSet,
  type ReadSet,
  type ReadSetResult,
  readPathOf,
  readSetOf,
  type StandDown,
} from "@suss/behavioral-ir";
