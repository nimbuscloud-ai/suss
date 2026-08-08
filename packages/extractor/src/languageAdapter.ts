/**
 * The small surface every language adapter implements, whatever that
 * language's own tooling looks like underneath.
 *
 * Anything TypeScript-specific, such as the ts-morph Project a caller needs
 * for corroborate's sandboxed execution, belongs on that adapter's own type
 * rather than here. This interface never gets a field that mentions one
 * particular language's tooling.
 */

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
