/**
 * The result shape a why session hands back, shared by every language
 * adapter so the CLI reads one type regardless of which adapter
 * answered. Each adapter follows its own source to a witness proof
 * over `RESOLUTION_RULES` and renders it through `explainResolutionProof`;
 * this is what that render comes back as.
 */

import type { ResolutionExplanation } from "./explain.js";

/** A value or function said the way an answer prints it. */
export interface ValueLocation {
  name: string;
  /** Relative to the session root when under it, absolute otherwise. */
  file: string;
  line: number;
}

/** What one witness re-evaluation cost, said rather than hidden. */
export interface ExplainStats {
  /** Facts the run had extracted, which the proof pass reran. */
  baseFacts: number;
  /** Facts the exhaustive pass derived on top of those. */
  derivedFacts: number;
  evaluateMs: number;
}

export interface WhyExplained {
  explanation: ResolutionExplanation;
  /** The chain's atoms, each said in source terms. */
  chain: string[];
  /** The chain and its reasons as printable lines. */
  lines: string[];
  target: ValueLocation;
  stats: ExplainStats;
}
