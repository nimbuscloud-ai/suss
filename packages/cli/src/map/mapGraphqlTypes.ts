/**
 * Every GraphQL type the run knows, with each field's arguments and type.
 *
 * A field's shape comes from what its resolver in code declares, and the
 * schema's type definitions fill in the fields no resolver declares. A
 * field whose type is another type the run knows links to it on the page.
 * Types are written the way `inspect` writes them, so a schema's `ID` and
 * `String` both read as `string`: the summaries keep no difference.
 */

import {
  readGraphqlMetadata,
  readSourceDocumentMetadata,
} from "@suss/behavioral-ir";

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
  // definitions, so each document's are read once.
  const read = new Set<string>();
  for (const summary of resolvers) {
    const definitions = summary.definitions;
    const document =
      readSourceDocumentMetadata(summary)?.label ?? summary.location.file;
    if (
      definitions === undefined ||
      read.has(document) ||
      !units.isSpec(summary)
    ) {
      continue;
    }
    read.add(document);
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

  return [...types]
    .map(([name, fields]) => ({ name, fields: [...fields.values()] }))
    .sort(byRootThenName);
}

function resolverPlace(
  summary: BehavioralSummary,
): { type: string; field: string } | null {
  const semantics = summary.identity.boundaryBinding?.semantics as
    | Record<string, unknown>
    | undefined;
  if (
    summary.kind !== "resolver" ||
    semantics?.name !== "graphql-resolver" ||
    typeof semantics.typeName !== "string" ||
    typeof semantics.fieldName !== "string"
  ) {
    return null;
  }
  return { type: semantics.typeName, field: semantics.fieldName };
}

function byRootThenName(a: GraphqlType, b: GraphqlType): number {
  const rank = (name: string) => {
    const at = ROOT_ORDER.indexOf(name);
    return at === -1 ? ROOT_ORDER.length : at;
  };
  return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
}
