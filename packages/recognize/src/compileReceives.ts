/**
 * Turns a receive chain into the hook the adapter's invocation walk calls
 * on every call.
 *
 * A receive is read at a call of one of the language's decoders. The hook
 * asks whether the call decodes under the chain's encoding, then walks
 * each envelope from the payload outward, a step at a time, until one of
 * them reaches what the platform handed the unit. The fields are the keys
 * the program reads off what the decoder gives back. DESIGN.md has each
 * step.
 */

import { messageBusBinding } from "@suss/behavioral-ir";

import { opsIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { EffectArg, InvocationRecognizer } from "@suss/extractor";
import type {
  Chain,
  Envelope,
  EnvelopeStep,
  MessageReceiveEnding,
  MethodMeaning,
} from "./chain.js";
import type { ValueOps } from "./ops.js";

/** A receive chain, as the hook the adapter dispatches to on every call. */
export function compileReceives(
  chain: Chain<MethodMeaning>,
  recognition: string,
): InvocationRecognizer {
  const ending = chain.ending as MessageReceiveEnding;
  return (_call: unknown, ctx: unknown): Effect[] | null => {
    const ops = opsIn(ctx);
    const decoded = ops?.decodes?.() ?? null;
    if (
      ops === null ||
      decoded === null ||
      decoded.codec !== ending.codec ||
      !ending.envelope.some((envelope) => reaches(envelope, decoded.value))
    ) {
      return null;
    }
    const keys = decoded.result.keysRead?.() ?? [];
    return [
      {
        type: "interaction",
        binding: messageBusBinding({
          recognition,
          messageBus: ending.wire,
          channel: null,
        }),
        callee: ops.calleeText(),
        interaction: {
          class: "message-receive",
          ...(keys.length === 0
            ? {}
            : { body: { kind: "object", fields: fieldsNamed(keys) } }),
        },
      },
    ];
  };
}

/**
 * Whether the envelope's steps lead from the payload back to what the
 * platform handed the unit. The steps are written outermost first, so the
 * walk takes them last to first, and `from` is asked of where it ends.
 */
function reaches(envelope: Envelope, payload: ValueOps): boolean {
  let at: ValueOps | null = payload;
  for (const step of [...envelope.path].reverse()) {
    if (at === null) {
      return false;
    }
    at = STEPS[kindOf(step)](step, at);
  }
  return (
    at !== null &&
    (envelope.from === undefined || at.typed?.(envelope.from) === true)
  );
}

type StepKind = "read" | "each";

function kindOf(step: EnvelopeStep): StepKind {
  return "read" in step ? "read" : "each";
}

/** One step outward: the object a read of the step's key is off, or the collection an element comes from. */
const STEPS: Record<
  StepKind,
  (step: EnvelopeStep, value: ValueOps) => ValueOps | null
> = {
  read: (step, value) => {
    const read = value.read?.() ?? null;
    return read !== null && "read" in step && read.key === step.read
      ? read.object
      : null;
  },
  each: (_step, value) => value.element?.() ?? null,
};

/** Pairing compares field names only, so each value is a placeholder. */
function fieldsNamed(keys: readonly string[]): Record<string, EffectArg> {
  return Object.fromEntries(
    keys.map((key) => [key, { kind: "identifier", name: key }]),
  );
}
