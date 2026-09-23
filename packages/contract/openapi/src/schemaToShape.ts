/**
 * Converts an OpenAPI Schema object into a TypeShape. A `$ref` resolves
 * against the document's named schemas. A ref met again while it is still
 * being resolved becomes a `ref` placeholder, so a recursive schema does
 * not loop.
 *
 * 3.0's `nullable: true` and 3.1's `"null"` in `type` both add `null` to
 * the shape. A `discriminator` mapping narrows the discriminator property
 * of each variant to the value that selects it.
 */

import type { TypeShape } from "@suss/behavioral-ir";
import type {
  OpenApiDiscriminator,
  OpenApiSchema,
  OpenApiSpec,
  SchemaTypeName,
} from "./spec.js";

export interface SchemaContext {
  spec: OpenApiSpec;
  /** Names of refs currently being resolved, used for cycle detection. */
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

  // 3.1 writes `type: ["string", "null"]` where 3.0 writes
  // `nullable: true`.
  const { primary, nullable } = normalizeType(schema);

  // 3.1's `const` is shorthand for a one-value enum.
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
      // The schema does not constrain the value at all.
      return { type: "unknown" };
  }
}

function normalizeType(schema: OpenApiSchema): {
  primary: SchemaTypeName | null;
  nullable: boolean;
} {
  // 3.0 keeps the nullable flag apart from `type`.
  if (!Array.isArray(schema.type)) {
    return {
      primary: schema.type ?? null,
      nullable: schema.nullable === true,
    };
  }
  // 3.1 lists "null" among the types instead.
  const nonNull = schema.type.filter((t): t is SchemaTypeName => t !== "null");
  const nullable = schema.type.length !== nonNull.length;
  if (nonNull.length === 0) {
    return { primary: "null", nullable: false };
  }
  // With several non-null types, only the first is kept. A union would be
  // accurate, but nearly every spec writes `[T, "null"]`.
  return { primary: nonNull[0], nullable };
}

function objectToShape(schema: OpenApiSchema, ctx: SchemaContext): TypeShape {
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

  // A property missing from `required` may be absent, so its shape gets
  // `undefined` and the checker can tell it apart from a guaranteed one.
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
  // An allOf of objects merges their properties. When any part is not an
  // object, the result is a union of the parts.
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
 * Wrapping the variant in an allOf lets the pinned discriminator value
 * combine with whatever the variant declares. A variant the mapping does
 * not list is left as it is.
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
  // 3.x keeps named schemas under components and 2.0 under definitions.
  // Any other ref stays a named placeholder, so a reader can still see
  // what it pointed at.
  const match = /^#\/(?:components\/schemas|definitions)\/(.+)$/.exec(ref);
  if (match === null) {
    return { type: "ref", name: ref };
  }
  const name = match[1];

  if (ctx.resolving.has(name)) {
    // A recursive schema stops at a named ref, which a reader can follow
    // through its own map of named schemas.
    return { type: "ref", name };
  }

  const target =
    ctx.spec.components?.schemas?.[name] ?? ctx.spec.definitions?.[name];
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
