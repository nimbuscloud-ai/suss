// schema-to-shape.ts — Convert an OpenAPI Schema object into a suss TypeShape.
//
// $ref is resolved against `components.schemas`. Cycles are broken by
// emitting a `{ type: "ref", name }` placeholder when we re-enter a ref
// already on the resolution stack, so recursive schemas don't blow the
// stack. Top-level use of a ref still gets resolved on the first encounter.

import type { TypeShape } from "@suss/behavioral-ir";
import type { OpenApiSchema, OpenApiSpec } from "./spec.js";

export interface SchemaContext {
  spec: OpenApiSpec;
  /** Names of refs currently being resolved — used for cycle detection. */
  resolving: Set<string>;
}

export function newContext(spec: OpenApiSpec): SchemaContext {
  return { spec, resolving: new Set() };
}

export function schemaToShape(
  schema: OpenApiSchema | undefined,
  ctx: SchemaContext,
): TypeShape {
  if (schema === undefined) {
    return { type: "unknown" };
  }

  if (schema.$ref !== undefined) {
    return resolveRef(schema.$ref, ctx);
  }

  // enum becomes a union of literals (filtering out nulls — handled below
  // by `nullable`)
  if (schema.enum !== undefined && schema.enum.length > 0) {
    const variants: TypeShape[] = [];
    for (const value of schema.enum) {
      if (value === null) {
        variants.push({ type: "null" });
      } else if (typeof value === "string" || typeof value === "number") {
        variants.push({ type: "literal", value });
      } else if (typeof value === "boolean") {
        variants.push({ type: "literal", value });
      }
    }
    if (variants.length === 1) {
      return wrapNullable(variants[0], schema.nullable);
    }
    return wrapNullable({ type: "union", variants }, schema.nullable);
  }

  // oneOf / anyOf become a union; allOf is intersected by merging objects
  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    const variants = (schema.oneOf ?? schema.anyOf ?? []).map((s) =>
      schemaToShape(s, ctx),
    );
    return wrapNullable({ type: "union", variants }, schema.nullable);
  }

  if (schema.allOf !== undefined) {
    return wrapNullable(mergeAllOf(schema.allOf, ctx), schema.nullable);
  }

  switch (schema.type) {
    case "object":
      return wrapNullable(objectToShape(schema, ctx), schema.nullable);
    case "array":
      return wrapNullable(
        { type: "array", items: schemaToShape(schema.items, ctx) },
        schema.nullable,
      );
    case "string":
      return wrapNullable({ type: "text" }, schema.nullable);
    case "integer":
      return wrapNullable({ type: "integer" }, schema.nullable);
    case "number":
      return wrapNullable({ type: "number" }, schema.nullable);
    case "boolean":
      return wrapNullable({ type: "boolean" }, schema.nullable);
    default:
      // No type, no enum, no $ref, no composition — really unknown
      return { type: "unknown" };
  }
}

function objectToShape(schema: OpenApiSchema, ctx: SchemaContext): TypeShape {
  // additionalProperties present without `properties` → dictionary shape
  if (
    schema.properties === undefined &&
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  ) {
    const valueSchema =
      schema.additionalProperties === true
        ? undefined
        : schema.additionalProperties;
    return { type: "dictionary", values: schemaToShape(valueSchema, ctx) };
  }

  const properties: Record<string, TypeShape> = {};
  for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
    properties[name] = schemaToShape(propSchema, ctx);
  }
  return { type: "record", properties };
}

function mergeAllOf(parts: OpenApiSchema[], ctx: SchemaContext): TypeShape {
  // For allOf we attempt a structural merge across object members. Anything
  // non-object falls back to a union (the safe default).
  const merged: Record<string, TypeShape> = {};
  let allObject = true;
  for (const part of parts) {
    const shape = schemaToShape(part, ctx);
    if (shape.type !== "record") {
      allObject = false;
      break;
    }
    for (const [k, v] of Object.entries(shape.properties)) {
      merged[k] = v;
    }
  }
  if (allObject) {
    return { type: "record", properties: merged };
  }
  return {
    type: "union",
    variants: parts.map((p) => schemaToShape(p, ctx)),
  };
}

function wrapNullable(
  shape: TypeShape,
  nullable: boolean | undefined,
): TypeShape {
  if (nullable !== true) {
    return shape;
  }
  return { type: "union", variants: [shape, { type: "null" }] };
}

function resolveRef(ref: string, ctx: SchemaContext): TypeShape {
  // Only #/components/schemas/<Name> refs are supported. Anything else
  // becomes a named ref placeholder so the consumer at least knows what
  // was intended.
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (match === null) {
    return { type: "ref", name: ref };
  }
  const name = match[1];

  if (ctx.resolving.has(name)) {
    // Cycle — emit a named ref instead of recursing. Consumers reading the
    // summary as a graph can resolve back through their own component map.
    return { type: "ref", name };
  }

  const target = ctx.spec.components?.schemas?.[name];
  if (target === undefined) {
    return { type: "ref", name };
  }

  ctx.resolving.add(name);
  try {
    return schemaToShape(target, ctx);
  } finally {
    ctx.resolving.delete(name);
  }
}
