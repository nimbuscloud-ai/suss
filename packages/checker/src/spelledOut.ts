/**
 * A summary with its named types put back into its shapes.
 *
 * An extract writes a named type once and refers to it after that, so a
 * reader following a name has somewhere to look and one megabyte of
 * repeated expansion never happens. Comparing two refs can only tell
 * you whether the names match, which is not what a check is for, so the
 * table goes back in before anything compares them.
 *
 * Nothing is modified in place: the shapes handed back are new and the
 * summary that was passed in is untouched.
 */

import { withDefinitionsInlined } from "@suss/ir-core";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

/** A summary whose shapes spell out every type it refers to by name. */
export function summaryWithDefinitionsInlined(
  summary: BehavioralSummary,
): BehavioralSummary {
  const definitions = summary.definitions;
  if (definitions === undefined) {
    return summary;
  }
  const spellOut = (shape: TypeShape): TypeShape =>
    withDefinitionsInlined(shape, definitions);

  return {
    ...summary,
    inputs: summary.inputs.map((input) =>
      "shape" in input && input.shape !== null
        ? { ...input, shape: spellOut(input.shape) }
        : input,
    ),
    transitions: summary.transitions.map((transition) => ({
      ...transition,
      ...(transition.expectedInput === undefined
        ? {}
        : { expectedInput: spellOut(transition.expectedInput) }),
      output: outputSpelledOut(transition.output, spellOut),
      effects: transition.effects.map((effect) =>
        effectSpelledOut(effect, spellOut),
      ),
    })),
  };
}

/** What an interaction returns is a shape too, and refers to types the
 * same way. */
function effectSpelledOut(
  effect: BehavioralSummary["transitions"][number]["effects"][number],
  spellOut: (shape: TypeShape) => TypeShape,
): BehavioralSummary["transitions"][number]["effects"][number] {
  if (
    effect.type === "interaction" &&
    "responseShape" in effect.interaction &&
    effect.interaction.responseShape !== undefined
  ) {
    return {
      ...effect,
      interaction: {
        ...effect.interaction,
        responseShape: spellOut(effect.interaction.responseShape),
      },
    };
  }
  return effect;
}

function outputSpelledOut(
  output: BehavioralSummary["transitions"][number]["output"],
  spellOut: (shape: TypeShape) => TypeShape,
): BehavioralSummary["transitions"][number]["output"] {
  if (output.type === "response") {
    return output.body === null
      ? output
      : { ...output, body: spellOut(output.body) };
  }
  if (output.type === "emit") {
    return output.payload === undefined
      ? output
      : { ...output, payload: spellOut(output.payload) };
  }
  if (output.type === "return") {
    return output.value === null
      ? output
      : { ...output, value: spellOut(output.value) };
  }
  return output;
}
