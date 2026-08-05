// producerShape.test.ts: the property for queue producers.
//
// However the queue is named, the send is recorded. A name the code
// states reaches the channel; a name it cannot state leaves the
// channel null and the send still there. Six namings, run
// exhaustively: the space is small enough that sampling would only
// hide one.

import { describe, expect, it } from "vitest";

import { PRODUCER_NAMINGS } from "./producerShape.js";
import {
  formatShapeFailure,
  runProducerShapeDifferential,
  shapeFailed,
} from "./shapeDifferential.js";

describe("shape fuzzer, sound tier (queue producers)", () => {
  for (const naming of PRODUCER_NAMINGS) {
    it(
      `the send survives when the queue is named by ${naming}`,
      { timeout: 120_000 },
      async () => {
        const result = await runProducerShapeDifferential({ naming });
        if (shapeFailed(result)) {
          throw new Error(formatShapeFailure(result));
        }
        expect(result.findings).toEqual([]);
      },
    );
  }
});
