/**
 * The list of protocol definitions, and the lookups built from it.
 *
 * Each protocol module in this directory exports one
 * `BoundarySemanticsDefinition`. They are listed twice, once for the
 * schema union and once for the behavior lookup, and the type check at
 * the bottom fails compilation if the two lists differ. Besides its own
 * module, a new protocol needs one line in each list.
 */

import { z } from "zod";

import { functionCallSemantics } from "./functionCall.js";
import { graphqlOperationSemantics } from "./graphqlOperation.js";
import { graphqlResolverSemantics } from "./graphqlResolver.js";
import { messageBusSemantics } from "./messageBus.js";
import { metricSemantics } from "./metric.js";
import { restSemantics } from "./rest.js";
import { runtimeConfigSemantics } from "./runtimeConfig.js";
import { storageSemantics } from "./storage.js";
import { unitInvocationSemantics } from "./unitInvocation.js";

import type { BoundaryBehavior, SemconvAttribute } from "./definition.js";

/**
 * The discriminated union every boundary binding validates against.
 * Built from the protocol modules' own schemas.
 */
export const SemanticsSchema = z.discriminatedUnion("name", [
  restSemantics.schema,
  functionCallSemantics.schema,
  graphqlResolverSemantics.schema,
  graphqlOperationSemantics.schema,
  runtimeConfigSemantics.schema,
  storageSemantics.schema,
  messageBusSemantics.schema,
  metricSemantics.schema,
  unitInvocationSemantics.schema,
]);

export type Semantics = z.infer<typeof SemanticsSchema>;

const DEFINITIONS = [
  restSemantics,
  functionCallSemantics,
  graphqlResolverSemantics,
  graphqlOperationSemantics,
  runtimeConfigSemantics,
  storageSemantics,
  messageBusSemantics,
  metricSemantics,
  unitInvocationSemantics,
] as const;

const BY_NAME = new Map<string, (typeof DEFINITIONS)[number]>(
  DEFINITIONS.map((d) => [d.name, d]),
);

/**
 * The behavior for a semantics value. A lookup by name cannot narrow to
 * the protocol's own type, so the cast happens here once, as it does in
 * `dispatchByType`.
 */
export function behaviorOf(semantics: Semantics): BoundaryBehavior<Semantics> {
  return definitionFor(semantics.name).behavior as BoundaryBehavior<Semantics>;
}

function definitionFor(name: string): (typeof DEFINITIONS)[number] {
  const definition = BY_NAME.get(name);
  if (definition === undefined) {
    // Unreachable while the union and the list contain the same
    // protocols, and the type check at the bottom keeps them in step.
    throw new Error(`no boundary definition for semantics "${name}"`);
  }
  return definition;
}

/**
 * Which of a semantics value's fields the OpenTelemetry semantic
 * conventions have an attribute for. Each protocol's keys are
 * type-checked against its schema where it declares them, so this
 * lookup can return them as plain strings.
 */
export function semconvMappingOf(
  semantics: Semantics,
): Readonly<Record<string, SemconvAttribute>> {
  return definitionFor(semantics.name).semconv as Readonly<
    Record<string, SemconvAttribute>
  >;
}

/**
 * Every protocol's behavior, for a lookup that starts from a string,
 * such as a suppression rule's boundary. Same cast as `behaviorOf`.
 */
export function allBehaviors(): ReadonlyArray<BoundaryBehavior<Semantics>> {
  return DEFINITIONS.map((d) => d.behavior as BoundaryBehavior<Semantics>);
}

// Compile-time completeness: every union member has a definition and
// every definition is in the union. A protocol module added to one
// list and not the other fails here.
type DefinedNames = (typeof DEFINITIONS)[number]["name"];
type UnionCoversDefinitions = Semantics["name"] extends DefinedNames
  ? true
  : never;
type DefinitionsCoverUnion = DefinedNames extends Semantics["name"]
  ? true
  : never;
const _unionCoversDefinitions: UnionCoversDefinitions = true;
const _definitionsCoverUnion: DefinitionsCoverUnion = true;
void _unionCoversDefinitions;
void _definitionsCoverUnion;
