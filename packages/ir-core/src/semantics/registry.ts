/**
 * Where the protocol modules come together.
 *
 * Each protocol under this directory exports one
 * `BoundarySemanticsDefinition`. This file lists them twice, once for
 * the schema union and once for the behavior lookup, and the type check
 * at the bottom fails compilation if the two lists ever cover different
 * sets. Adding a protocol changes this file and no other, by one line in
 * each list.
 */

import { z } from "zod";

import { functionCallSemantics } from "./functionCall.js";
import { graphqlOperationSemantics } from "./graphqlOperation.js";
import { graphqlResolverSemantics } from "./graphqlResolver.js";
import { messageBusSemantics } from "./messageBus.js";
import { restSemantics } from "./rest.js";
import { runtimeConfigSemantics } from "./runtimeConfig.js";
import { storageRelationalSemantics } from "./storageRelational.js";

import type { BoundaryBehavior } from "./definition.js";

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
  storageRelationalSemantics.schema,
  messageBusSemantics.schema,
]);

export type Semantics = z.infer<typeof SemanticsSchema>;

const DEFINITIONS = [
  restSemantics,
  functionCallSemantics,
  graphqlResolverSemantics,
  graphqlOperationSemantics,
  runtimeConfigSemantics,
  storageRelationalSemantics,
  messageBusSemantics,
] as const;

const BY_NAME = new Map<string, (typeof DEFINITIONS)[number]>(
  DEFINITIONS.map((d) => [d.name, d]),
);

/**
 * The behavior for a semantics value. This is the one place a cast
 * bridges the per-protocol definitions and the runtime lookup, the same
 * way `dispatchByType` does.
 */
export function behaviorOf(semantics: Semantics): BoundaryBehavior<Semantics> {
  const definition = BY_NAME.get(semantics.name);
  if (definition === undefined) {
    // Unreachable while the union and the list are the same modules;
    // the check below keeps them the same modules.
    throw new Error(`no boundary behavior for semantics "${semantics.name}"`);
  }
  return definition.behavior as BoundaryBehavior<Semantics>;
}

/**
 * Every protocol's behavior, for a lookup that starts from a string
 * rather than a semantics value, which is how a suppression rule's
 * boundary arrives. Same cast as `behaviorOf`.
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
