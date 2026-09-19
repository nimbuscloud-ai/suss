// The read-set rule moved into @suss/behavioral-ir so the intent
// checker can ask it too, and the intent checker does not depend on
// this package. The passes here keep importing it from where it was.

export {
  boundaryInputReads,
  type CarriesPayload,
  type ComparisonResult,
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
