// languageAdapter.ts: the coarse surface every language adapter answers
// to, independent of how that language's own tooling works underneath.
// A TypeScript-specific extra (the ts-morph Project a caller needs for
// something adapter-specific, such as corroborate's sandboxed execution)
// lives on that adapter's own type, not here, so this interface never
// carries a field naming a particular language's tooling.

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface LanguageAdapter {
  /**
   * Extract summaries from a specific list of files. Returns a
   * Promise so an implementation can do concurrent I/O during
   * discovery without bottlenecking on synchronous reads.
   */
  extractFromFiles(filePaths: string[]): Promise<BehavioralSummary[]>;
  /** Extract summaries from every source file the adapter's project knows about. */
  extractAll(): Promise<BehavioralSummary[]>;
}
