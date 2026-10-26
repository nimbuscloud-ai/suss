/**
 * Every GraphQL type the run knows, with each field's arguments and type.
 *
 * A field's shape comes from what its resolver in code declares, and the
 * type definitions in the summaries fill in the fields no resolver
 * declares, such as a connection's. A
 * field whose type is another type the run knows links to it on the page.
 * Types are written the way `inspect` writes them, so a schema's `ID` and
 * `String` both read as `string`: the summaries keep no difference.
 */

import {
  bindingIs,
  readGraphqlMetadata,
  readSourceDocumentMetadata,
} from "@suss/behavioral-ir";
import { declaredValueTypes } from "@suss/contract-graphql";

import { graphqlShapeOf } from "./mapEntries.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { GatheredEntries } from "./mapEntries.js";
import type { GraphqlField, GraphqlType } from "./mapModel.js";
import type { UnitTable } from "./mapUnits.js";

const ROOT_ORDER = ["Query", "Mutation", "Subscription"];

export function gatherGraphqlTypes(
  gathered: GatheredEntries,
  summaries: readonly BehavioralSummary[],
  units: UnitTable,
): GraphqlType[] {
  const types = new Map<string, Map<string, GraphqlField>>();
  const fieldsOf = (type: string): Map<string, GraphqlField> => {
    const known = types.get(type) ?? new Map<string, GraphqlField>();
    types.set(type, known);
    return known;
  };

  // Resolvers in code first, so a field keeps the resolver that serves it
  // and the arguments it declares.
  const resolvers = summaries.filter((s) => resolverPlace(s) !== null);
  const ordered = [
    ...resolvers.filter((s) => !units.isSpec(s)),
    ...resolvers.filter((s) => units.isSpec(s)),
  ];
  for (const summary of ordered) {
    const place = resolverPlace(summary);
    const contract = readGraphqlMetadata(summary)?.declaredContract;
    if (place === null || contract === undefined) {
      continue;
    }
    const fields = fieldsOf(place.type);
    if (fields.has(place.field)) {
      continue;
    }
    fields.set(place.field, {
      name: place.field,
      shape: graphqlShapeOf(contract),
      unit: units.isSpec(summary) ? null : units.of(summary),
      entry: gathered.entryOf.get(summary) ?? null,
    });
  }

  // Every field a schema declares has a copy of the whole schema's
  // definitions, so each document's are read once. A resolver in code
  // has only the types its own output refers to, such as a connection.
  const read = new Set<string>();
  for (const summary of ordered) {
    const definitions = summary.definitions;
    if (definitions === undefined) {
      continue;
    }
    if (units.isSpec(summary)) {
      const document =
        readSourceDocumentMetadata(summary)?.label ?? summary.location.file;
      if (read.has(document)) {
        continue;
      }
      read.add(document);
    }
    for (const [type, shape] of Object.entries(definitions)) {
      if (shape.type !== "record") {
        continue;
      }
      const fields = fieldsOf(type);
      for (const [name, field] of Object.entries(shape.properties)) {
        if (!fields.has(name)) {
          fields.set(name, {
            name,
            shape: graphqlShapeOf({ args: [], returnType: field }),
            unit: null,
            entry: null,
          });
        }
      }
    }
  }

  const objects: GraphqlType[] = [...types].map(([name, fields]) => ({
    name,
    kind: "object",
    fields: [...fields.values()],
    members: [],
  }));
  return [...objects, ...valueTypes(summaries, types)].sort(byRootThenName);
}

/**
 * The enums, unions and scalars the schemas in the run declare, read from
 * each schema's SDL once, so a field that returns one links to it.
 */
function valueTypes(
  summaries: readonly BehavioralSummary[],
  objects: ReadonlyMap<string, unknown>,
): GraphqlType[] {
  const found = new Map<string, GraphqlType>();
  const seen = new Set<string>();
  for (const summary of summaries) {
    const sdl = readGraphqlMetadata(summary)?.schemaSdl;
    if (sdl === undefined || seen.has(sdl)) {
      continue;
    }
    seen.add(sdl);
    for (const type of declaredValueTypes(sdl)) {
      if (!objects.has(type.name) && !found.has(type.name)) {
        found.set(type.name, { ...type, fields: [] });
      }
    }
  }
  return [...found.values()];
}

function resolverPlace(
  summary: BehavioralSummary,
): { type: string; field: string } | null {
  const binding = summary.identity.boundaryBinding;
  if (
    summary.kind !== "resolver" ||
    !bindingIs(binding, "graphql-resolver") ||
    binding.semantics.typeName === null
  ) {
    return null;
  }
  return {
    type: binding.semantics.typeName,
    field: binding.semantics.fieldName,
  };
}

function byRootThenName(a: GraphqlType, b: GraphqlType): number {
  const rank = (name: string) => {
    const at = ROOT_ORDER.indexOf(name);
    return at === -1 ? ROOT_ORDER.length : at;
  };
  return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
}
