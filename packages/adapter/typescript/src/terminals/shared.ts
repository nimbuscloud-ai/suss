// shared.ts — types shared between every terminal matcher.

import type { RawTerminal } from "@suss/extractor";
import type { Node } from "ts-morph";

export interface FoundTerminal {
  node: Node;
  terminal: RawTerminal;
}
