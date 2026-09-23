/**
 * Reading a function the project wrote in front of a library, before
 * anything is extracted.
 *
 * A service writes `registerCrud(app, "users", handlers)` and puts the
 * library call one hop away, inside a helper of its own, where the path
 * is a parameter. The call site has the literals and no library; the
 * helper body has the library and no literals.
 *
 * A pack asks for the helper to be read once, over the whole project,
 * before any file is walked. What comes back says what the body does in
 * terms of the helper's own parameters, and the pack turns that into
 * discovery patterns and invocation recognizers.
 */

import type { DiscoveryPattern, InvocationRecognizer } from "./framework.js";

/**
 * One value inside a helper's body, said in the helper's own terms.
 *
 * Every variant is something a call site can fill in. Anything else is
 * `unread`, which a pack drops rather than guesses at.
 */
export type HelperValue =
  /**
   * A string, with `{N}` wherever parameter N was interpolated. A
   * literal with no interpolation comes back unchanged.
   */
  | { as: "text"; text: string }
  /** Parameter N, or one named property of it. */
  | { as: "parameter"; position: number; property?: string }
  /** An object literal, each property read the same way. */
  | { as: "object"; properties: Record<string, HelperValue> }
  /** A call, so a pack can see through `JSON.stringify(request)`. */
  | { as: "call"; callee: string; arguments: HelperValue[] }
  /** Something none of the above covers. */
  | { as: "unread" };

/** One call a helper's body makes, read in the helper's own terms. */
export interface HelperSink {
  /** The property the call was made through, or null for a bare call. */
  method: string | null;
  /** What the call was made on. */
  receiver: HelperValue;
  arguments: HelperValue[];
}

/** A function the project declares, as the index read it. */
export interface ProjectHelper {
  /** The declared name, which is the name call sites use. */
  name: string;
  /** Absolute path of the file declaring it. */
  file: string;
  /** Parameter names in declaration order. */
  parameters: string[];
  /**
   * Parameters some caller handed this pack's own value to. Empty when
   * the helper was found by its body rather than by a call site.
   */
  subjectParameters: number[];
  /** Every call its body makes that the search asked about. */
  sinks: HelperSink[];
}

/**
 * How the index picks out which of the project's functions to read.
 *
 * `subject` starts at a call site: a function the project passes one of
 * this pack's own values to is one of the pack's helpers, whatever the
 * helper's file imports. `text` starts at the body, for a pack whose
 * library is reached over the wire and has no import to look for. Both
 * searches use only facts about the library, as `requiresImport` does.
 */
export type HelperSearch =
  | { by: "subject" }
  | { by: "text"; contains: string[] };

/** What a pack contributes to a run once its helpers have been read. */
export interface HelperDeclarations {
  discovery?: DiscoveryPattern[];
  invocationRecognizers?: InvocationRecognizer[];
}

/** A pack's request to have the project's helpers read before extraction. */
export interface ProjectHelpers {
  find: HelperSearch;
  /**
   * Called once, before the first file is walked, to turn the helpers
   * into patterns and recognizers. It receives data and never an AST, so
   * a pack that declares it runs on any adapter that reads helpers.
   */
  declare(helpers: readonly ProjectHelper[]): HelperDeclarations;
}
