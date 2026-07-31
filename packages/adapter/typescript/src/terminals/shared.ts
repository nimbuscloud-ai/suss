// shared.ts — types shared between every terminal matcher.

import type { RawTerminal } from "@suss/extractor";
import type { Node } from "ts-morph";

export interface FoundTerminal {
  node: Node;
  terminal: RawTerminal;
  /**
   * The return this terminal came from: a ReturnStatement, or the body
   * of an arrow that returns without writing `return`. Absent when the
   * terminal is not a return at all, as a throw is not.
   *
   * The matcher is the only thing that knows, because `node` is
   * wherever the matcher stopped looking, which differs by matcher.
   * Anything downstream that guessed instead got it wrong.
   */
  source?: Node;
}
