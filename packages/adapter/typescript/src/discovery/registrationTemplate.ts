// registrationTemplate.ts (discovery handler) — expand a single
// helper-call into N virtual route registrations using pack-author
// templates. Each template substitutes positional arguments via
// `{N}` placeholders; the synthesized DiscoveredUnit carries
// `routeInfo` so the adapter pipeline picks up the REST binding
// directly (same path the decoratedRoute handler uses).
//
// A handler argument is written `{N}` or `{N}.prop`. Which function
// sits there is asked of the fact layer, so a helper handed a name, an
// imported object or a re-exported one reads the same as one handed a
// function written at the call. A computed property name and a chain
// deeper than one property are still unread, and a registration whose
// handler nothing reaches emits no unit.

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import {
  functionValueOf,
  objectLiteralOf,
  propertyValueOf,
} from "./resolveValue.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

type TemplateMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationTemplate" }
>;

export function discoverRegistrationTemplates(
  sourceFile: SourceFile,
  match: TemplateMatch,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  const localName = resolveImportedLocalName(sourceFile, match);
  if (localName === null) {
    return [];
  }

  const results: DiscoveredUnit[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    if (!isCallToHelper(node, localName)) {
      return;
    }
    const args = node.getArguments();

    for (const reg of match.registrations) {
      const path = substitutePath(reg.pathTemplate, args);
      if (path === null) {
        // Template referenced a non-literal arg slot; we can still
        // emit the registration with an opaque marker, but for v0
        // skip entirely so the report stays clean.
        continue;
      }
      const handler = resolveHandler(reg.handlerArg, args, resolution);
      if (handler === null) {
        continue;
      }
      results.push({
        func: handler.func,
        kind,
        name: handler.name,
        routeInfo: {
          method: reg.method.toUpperCase(),
          path,
        },
      });
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveImportedLocalName(
  sourceFile: SourceFile,
  match: TemplateMatch,
): string | null {
  // No importModule narrowing → match the helper by name regardless
  // of where it came from. Useful when the helper is locally
  // declared.
  if (match.importModule === undefined) {
    return match.helperName;
  }
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== match.importModule) {
      continue;
    }
    for (const namedImport of importDecl.getNamedImports()) {
      if (
        namedImport.getName() === match.helperName ||
        namedImport.getAliasNode()?.getText() === match.helperName
      ) {
        return namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      }
    }
    const defaultImport = importDecl.getDefaultImport();
    if (
      defaultImport !== undefined &&
      defaultImport.getText() === match.helperName
    ) {
      return defaultImport.getText();
    }
  }
  return null;
}

function isCallToHelper(call: CallExpression, localName: string): boolean {
  const callee = call.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === localName;
}

function substitutePath(template: string, args: Node[]): string | null {
  const re = /\{(\d+)\}/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(template);
  while (match !== null) {
    result += template.slice(lastIndex, match.index);
    const idx = Number(match[1]);
    const arg = args[idx];
    if (arg === undefined) {
      return null;
    }
    const literal = readStringLiteral(arg);
    if (literal === null) {
      // Non-literal arg in a path slot — return null so caller can
      // skip this registration. Tombstone emission is a v1 concern.
      return null;
    }
    result += literal;
    lastIndex = match.index + match[0].length;
    match = re.exec(template);
  }
  result += template.slice(lastIndex);
  return result;
}

function readStringLiteral(node: Node): string | null {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  return null;
}

function resolveHandler(
  template: string,
  args: Node[],
  resolution: ResolutionStore | undefined,
): { func: FunctionRoot; name: string } | null {
  // Parse the template: either `{N}` or `{N}.prop` (single property).
  // Multi-property chains and call-result handlers are out of v0.
  const m = /^\{(\d+)\}(?:\.([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(template);
  if (m === null) {
    return null;
  }
  const idx = Number(m[1]);
  const prop = m[2] ?? null;
  const arg = args[idx];
  if (arg === undefined) {
    return null;
  }

  if (prop === null) {
    const func = functionValueOf(arg, resolution);
    return func === null ? null : { func, name: handlerName(arg) };
  }
  return readPropertyAsFunction(arg, prop, resolution);
}

/**
 * What to call the handler an argument names. A name is the answer
 * where there is one; a function written out at the call has none, and
 * the kind is what a unit discovered here has carried since this
 * handler was written.
 */
function handlerName(value: Node): string {
  return Node.isIdentifier(value) ? value.getText() : value.getKindName();
}

/**
 * The function a named property of an argument holds. The argument is
 * an object literal at the call site, a name bound to one, or one built
 * in another module, and the fact layer answers for all three.
 */
function readPropertyAsFunction(
  arg: Node,
  prop: string,
  resolution: ResolutionStore | undefined,
): { func: FunctionRoot; name: string } | null {
  const obj = objectLiteralOf(arg, resolution);
  if (obj === null) {
    return null;
  }
  for (const property of obj.getProperties()) {
    if (propertyName(property) !== prop) {
      continue;
    }
    if (Node.isMethodDeclaration(property)) {
      return { func: property, name: prop };
    }
    const held = propertyValueOf(property);
    if (held === null) {
      return null;
    }
    const func = functionValueOf(held, resolution);
    return func === null
      ? null
      : { func, name: Node.isIdentifier(held) ? held.getText() : prop };
  }
  return null;
}

/** The name an object literal holds a property under. */
function propertyName(property: Node): string | null {
  if (
    Node.isPropertyAssignment(property) ||
    Node.isShorthandPropertyAssignment(property) ||
    Node.isMethodDeclaration(property)
  ) {
    return property.getName();
  }
  return null;
}
