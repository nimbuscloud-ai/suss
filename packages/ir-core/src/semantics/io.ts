/**
 * A stream the process writes to: standard output, standard error.
 *
 * Only the writing side is ever in a run. Whoever reads the stream is a
 * person, a shell or a test, and nothing declares them, so an io
 * boundary never pairs and never reports itself unpaired. It has a key
 * anyway, `io:stdout`, so a question, an intent document and a review
 * diff can all name the stream the same way.
 *
 * A write whose stream the reader could not settle, such as one to a
 * stream handed in through a parameter nobody could follow, has a null
 * target and no key.
 */

import { z } from "zod";

import { ioIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const IoSemanticsSchema = z.object({
  name: z.literal("io"),
  /** The stream, such as `stdout` or `stderr`. Null when the source does not say which. */
  target: z.string().nullable(),
});

export type IoSemantics = z.infer<typeof IoSemanticsSchema>;

export const ioSemantics = defineBoundarySemantics({
  name: "io",
  schema: IoSemanticsSchema,
  // The semantic conventions have no attribute for a process's own streams.
  semconv: {},
  behavior: {
    exchangesHttpResponses: false,
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    identityKey(semantics) {
      return semantics.target === null ? null : ioIdentityKey(semantics.target);
    },
    // Nothing declares the reading side, so a write has nothing to meet.
    canPair: () => false,
  },
});
