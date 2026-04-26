// schema-to-shape.ts — Convert an OpenAPI Schema object into a suss TypeShape.
//
// $ref is resolved against `components.schemas`. Cycles are broken by
// emitting a `{ type: "ref", name }` placeholder when we re-enter a ref
// already on the resolution stack, so recursive schemas don't blow the
// stack. Top-level use of a ref still gets resolved on the first encounter.
//
// Handles both OpenAPI 3.0 and 3.1 conventions:
//   - 3.0 `nullable: true` and 3.1 `type: [..., "null"]` both widen the
//     shape into a union with `{ type: "null" }`.
//   - 3.1 `const` is treated as a single-valued enum.
//   - 3.0/3.1 `discriminator` narrows the propertyName of each oneOf/anyOf
//     variant to the literal that maps to that variant.

import type { TypeShape } from "@suss/behavioral-ir";
import type {
  OpenApiDiscriminator,
  OpenApiSchema,
  OpenApiSpec,
  SchemaTypeName,
} from "./spec.js";

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

  // Normalize type + nullability before branching. OpenAPI 3.1 can say
  // `type: ["string", "null"]`, which is equivalent to 3.0's
  // `type: "string", nullable: true`. Extract whichever flavor is used.
  const { primary, nullable } = normalizeType(schema);

  // 3.1 `const` is a single-valued enum shorthand. Normalize it into the
  // same enum-handling path.
  const effectiveEnum =
    schema.const !== undefined ? [schema.const] : schema.enum;

  if (effectiveEnum !== undefined && effectiveEnum.length > 0) {
    const variants: TypeShape[] = [];
    for (const value of effectiveEnum) {
      if (value === null) {
        variants.push({ type: "null" });
      } else if (typeof value === "string" || typeof value === "number") {
        variants.push({ type: "literal", value });
      } else if (typeof value === "boolean") {
        variants.push({ type: "literal", value });
      }
    }
    if (variants.length === 1) {
      return wrapNullable(variants[0], nullable);
    }
    return wrapNullable({ type: "union", variants }, nullable);
  }

  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    const rawVariants = schema.oneOf ?? schema.anyOf ?? [];
    const variants = rawVariants.map((v) =>
      schemaToShape(
        schema.discriminator !== undefined
          ? applyDiscriminator(v, schema.discriminator)
          : v,
        ctx,
      ),
    );
    return wrapNullable({ type: "union", variants }, nullable);
  }

  if (schema.allOf !== undefined) {
    return wrapNullable(mergeAllOf(schema.allOf, ctx), nullable);
  }

  switch (primary) {
    case "object":
      return wrapNullable(objectToShape(schema, ctx), nullable);
    case "array":
      return wrapNullable(
        { type: "array", items: schemaToShape(schema.items, ctx) },
        nullable,
      );
    case "string":
      return wrapNullable({ type: "text" }, nullable);
    case "integer":
      return wrapNullable({ type: "integer" }, nullable);
    case "number":
      return wrapNullable({ type: "number" }, nullable);
    case "boolean":
      return wrapNullable({ type: "boolean" }, nullable);
    case "null":
      return { type: "null" };
    case null:
      // No type, no enum, no $ref, no composition — really unknown.
      return { type: "unknown" };
  }
}

function normalizeType(schema: OpenApiSchema): {
  primary: SchemaTypeName | null;
  nullable: boolean;
} {
  // 3.0 shape: nullable flag is separate from type.
  if (!Array.isArray(schema.type)) {
    return {
      primary: schema.type ?? null,
      nullable: schema.nullable === true,
    };
  }
  // 3.1 shape: type is an array; "null" in the array means nullable.
  const nonNull = schema.type.filter((t): t is SchemaTypeName => t !== "null");
  const nullable = schema.type.length !== nonNull.length;
  if (nonNull.length === 0) {
    return { primary: "null", nullable: false };
  }
  // For multi-type arrays (e.g. ["string", "integer"]) we take the first
  // concrete type as primary. That's a v0 simplification — a proper
  // handling would emit a union. Deferred; the common case in practice
  // is [T, "null"].
  return { primary: nonNull[0], nullable };
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

  // OpenAPI's `required` lists the property names that MUST be present.
  // Anything not in the list is optional — encode that as a union with
  // `undefined` so downstream consumers (and the cross-boundary checker)
  // can distinguish guaranteed vs absent-able fields.
  const required = new Set(schema.required ?? []);
  const properties: Record<string, TypeShape> = {};
  for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
    const shape = schemaToShape(propSchema, ctx);
    properties[name] = required.has(name) ? shape : makeOptional(shape);
  }
  return { type: "record", properties };
}

function makeOptional(shape: TypeShape): TypeShape {
  if (shape.type === "union") {
    if (shape.variants.some((v) => v.type === "undefined")) {
      return shape;
    }
    return {
      type: "union",
      variants: [...shape.variants, { type: "undefined" }],
    };
  }
  return { type: "union", variants: [shape, { type: "undefined" }] };
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

/**
 * Narrow the discriminator property of a oneOf/anyOf variant to the
 * literal value that maps to it. Operates on a synthesized allOf so the
 * narrowing composes with whatever the variant already declared.
 *
 * Without a mapping entry for this variant we return the variant
 * unchanged — consumers have to rely on the variant's own schema to
 * include the narrowed literal, if any. With a mapping entry, we add
 * a synthetic property declaration that pins the discriminator to the
 * mapping key.
 */
function applyDiscriminator(
  variant: OpenApiSchema,
  disc: OpenApiDiscriminator,
): OpenApiSchema {
  if (variant.$ref === undefined || disc.mapping === undefined) {
    return variant;
  }
  const entry = Object.entries(disc.mapping).find(
    ([, ref]) => ref === variant.$ref,
  );
  if (entry === undefined) {
    return variant;
  }
  const [literal] = entry;
  return {
    allOf: [
      variant,
      {
        type: "object",
        required: [disc.propertyName],
        properties: { [disc.propertyName]: { const: literal } },
      },
    ],
  };
}

function wrapNullable(shape: TypeShape, nullable: boolean): TypeShape {
  if (!nullable) {
    return shape;
  }
  if (shape.type === "union" && shape.variants.some((v) => v.type === "null")) {
    return shape;
  }
  if (shape.type === "union") {
    return { type: "union", variants: [...shape.variants, { type: "null" }] };
  }
  if (shape.type === "null") {
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
