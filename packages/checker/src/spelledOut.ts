/**
 * A summary with its named types put back into its shapes.
 *
 * An extract writes a named type once and refers to it by name after
 * that, which keeps the file from growing by a megabyte of repeated
 * expansion. Comparing two refs only tells you whether the names match,
 * and a check needs to compare the shapes, so the definitions go back
 * in before anything compares them.
 *
 * The summary passed in is left unchanged, and the shapes returned are
 * new objects.
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

/** An interaction's response shape can refer to named types too. */
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
