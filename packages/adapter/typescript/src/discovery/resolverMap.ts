// resolverMap.ts (discovery handler) — GraphQL code-first resolvers
// (Apollo Server, GraphQL Yoga, …). Finds `new ApolloServer({
// resolvers })` constructions and emits one unit per `Type.field`
// resolver function.
//
// The map, the per-type object, the function under a field and the
// schema are each asked of the fact layer, so a resolver map assembled
// across modules reads the same as one written at the construction. A
// spread in either object is the same question again, asked of the name
// being spread.

import { Node, type ObjectLiteralExpression, type SourceFile } from "ts-morph";

import { resolveImportedLocalName } from "./resolveImport.js";
import {
  couldNameAValue,
  functionValueOf,
  objectLiteralOf,
  propertiesOf,
  propertyValueOf,
} from "./resolveValue.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

export function discoverResolverMaps(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "resolverMap" }>,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  const localName = resolveImportedLocalName(
    sourceFile,
    match.importModule,
    match.importName,
  );
  if (localName === null) {
    return [];
  }

  const mapProperty = match.mapProperty;
  const excludeTypes = new Set(match.excludeTypes ?? []);
  const results: DiscoveredUnit[] = [];

  sourceFile.forEachDescendant((node) => {
    // Match both `new ApolloServer({...})` and `apolloServer({...})`.
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== localName) {
      return;
    }
    const args = node.getArguments();
    if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) {
      return;
    }
    const config = args[0];

    // Find the resolvers property on the config object.
    const resolversProp = config.getProperty(mapProperty);
    if (resolversProp === undefined) {
      return;
    }

    const resolversObj = resolverMapObject(resolversProp, resolution);
    if (resolversObj === null) {
      return;
    }

    // typeDefs lives alongside `resolvers` on the same config
    // object. Capture it once per ApolloServer construction; all
    // resolvers discovered below share the same SDL.
    const schemaSdl = extractTypeDefsSdl(config, resolution);

    // Walk type → field → function.
    for (const typeProp of propertiesOf(resolversObj, resolution)) {
      const typeName = resolverPropertyName(typeProp);
      if (typeName === null || excludeTypes.has(typeName)) {
        continue;
      }
      const typeObj = resolverMapObject(typeProp, resolution);
      if (typeObj === null) {
        continue;
      }
      for (const fieldProp of propertiesOf(typeObj, resolution)) {
        const fieldName = resolverPropertyName(fieldProp);
        if (fieldName === null) {
          continue;
        }
        const fn = resolverPropertyFunction(fieldProp, resolution);
        if (fn === null) {
          continue;
        }
        results.push({
          func: fn,
          kind,
          name: `${typeName}.${fieldName}`,
          resolverInfo: {
            typeName,
            fieldName,
            ...(schemaSdl !== null ? { schemaSdl } : {}),
          },
        });
      }
    }
  });

  return results;
}

/**
 * The object literal holding `Type.field` functions, given the property
 * that names the resolver map on the config object.
 *
 * The map is written inline, handed over by name, or built in another
 * module and imported, and the fact layer follows all three without any
 * of them being written down here.
 */
function resolverMapObject(
  prop: Node,
  resolution: ResolutionStore | undefined,
): ObjectLiteralExpression | null {
  const held = propertyValueOf(prop);
  return held === null ? null : objectLiteralOf(held, resolution);
}

/**
 * The SDL the `typeDefs` property of an ApolloServer config states.
 *
 * A schema composed at run time (`mergeTypeDefs([...])`, an array of
 * sources) has no written form to read, and the answer is null. The
 * checker's selection pairing treats a missing SDL as nothing to
 * validate against rather than as an empty schema.
 */
function extractTypeDefsSdl(
  config: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  if (!Node.isObjectLiteralExpression(config)) {
    return null;
  }
  const prop = config.getProperty("typeDefs");
  if (prop === undefined) {
    return null;
  }
  const held = propertyValueOf(prop);
  return held === null ? null : schemaSdlOf(held, resolution);
}

/**
 * The SDL a value carries. A name is followed to the expression it is
 * written as, which is the same question the GraphQL recognizers ask
 * about a document held in a constant.
 */
function schemaSdlOf(
  expr: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  const written = writtenSdl(expr);
  if (written !== null) {
    return written;
  }
  if (resolution === undefined || !couldNameAValue(expr)) {
    return null;
  }
  const resolved = resolution.resolveWrittenValue(expr);
  return resolved === null ? null : writtenSdl(resolved);
}

/** The SDL an expression written out here states, when it states one. */
function writtenSdl(expr: Node): string | null {
  if (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr)
  ) {
    const value = expr.getLiteralValue();
    // An empty string has no schema content to validate selections
    // against, and downstream code already special-cases a missing SDL.
    return value === "" ? null : value;
  }
  if (Node.isTaggedTemplateExpression(expr)) {
    const tag = expr.getTag();
    if (Node.isIdentifier(tag) && tag.getText() === "gql") {
      const template = expr.getTemplate();
      // Substitutions inside typeDefs are not legal SDL, so only a
      // no-substitution template says anything readable.
      if (Node.isNoSubstitutionTemplateLiteral(template)) {
        return template.getLiteralValue();
      }
    }
  }
  return null;
}

function resolverPropertyName(prop: Node): string | null {
  if (Node.isPropertyAssignment(prop) || Node.isMethodDeclaration(prop)) {
    return prop.getName();
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    return prop.getName();
  }
  return null;
}

function resolverPropertyFunction(
  prop: Node,
  resolution: ResolutionStore | undefined,
): FunctionRoot | null {
  if (Node.isMethodDeclaration(prop)) {
    return prop;
  }
  const held = propertyValueOf(prop);
  return held === null ? null : functionValueOf(held, resolution);
}
