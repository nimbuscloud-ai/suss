// registrationTemplate.ts (discovery handler) — expand a single
// helper-call into N virtual route registrations using pack-author
// templates. Each template substitutes positional arguments via
// `{N}` placeholders; the synthesized DiscoveredUnit carries
// `routeInfo` so the adapter pipeline picks up the REST binding
// directly (same path the decoratedRoute handler uses).
//
// Recognized handler-arg shapes for v0:
//
//   - `{N}` where the argument is a literal function expression
//   - `{N}` where the argument is an identifier referencing a
//     locally-declared function (function declaration or `const fn = () => {...}`)
//   - `{N}.prop` where the argument is a literal object literal with
//     `prop: <function>` or `prop() {}` shorthand
//   - `{N}.prop` where the argument is an identifier referencing a
//     locally-declared object literal with `prop: <function>`
//
// Other shapes (call-result handlers, computed property names, deeply
// chained access) are out of v0 scope. Skipped registrations do not
// emit a unit — silent for now; a tombstone surface would be its own
// follow-up.

import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { DiscoveredUnit } from "./shared.js";

type TemplateMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationTemplate" }
>;

export function discoverRegistrationTemplates(
  sourceFile: SourceFile,
  match: TemplateMatch,
  kind: string,
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
      const handler = resolveHandler(reg.handlerArg, args);
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
    return resolveArgAsFunction(arg);
  }
  return readPropertyAsFunction(arg, prop);
}

function resolveArgAsFunction(
  arg: Node,
): { func: FunctionRoot; name: string } | null {
  if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
    return {
      func: arg as FunctionRoot,
      name: arg.getKindName(),
    };
  }
  if (Node.isIdentifier(arg)) {
    const name = arg.getText();
    const decl = findLocalFunctionDecl(arg);
    if (decl === null) {
      return null;
    }
    return { func: decl, name };
  }
  return null;
}

function readPropertyAsFunction(
  arg: Node,
  prop: string,
): { func: FunctionRoot; name: string } | null {
  // Object literal at the call site: `registerCrud(app, 'users', { list: getUsers })`.
  if (Node.isObjectLiteralExpression(arg)) {
    return readPropertyFromObjectLiteral(arg, prop);
  }
  // Identifier resolving to a local object-literal binding.
  if (Node.isIdentifier(arg)) {
    const obj = findLocalObjectLiteral(arg);
    if (obj === null) {
      return null;
    }
    return readPropertyFromObjectLiteral(obj, prop);
  }
  return null;
}

function readPropertyFromObjectLiteral(
  obj: ObjectLiteralExpression,
  prop: string,
): { func: FunctionRoot; name: string } | null {
  for (const property of obj.getProperties()) {
    if (Node.isMethodDeclaration(property) && property.getName() === prop) {
      return { func: property as FunctionRoot, name: prop };
    }
    if (Node.isPropertyAssignment(property) && property.getName() === prop) {
      const init = property.getInitializer();
      if (init === undefined) {
        return null;
      }
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        return { func: init as FunctionRoot, name: prop };
      }
      if (Node.isIdentifier(init)) {
        const decl = findLocalFunctionDecl(init);
        if (decl === null) {
          return null;
        }
        return { func: decl, name: init.getText() };
      }
    }
    if (
      Node.isShorthandPropertyAssignment(property) &&
      property.getName() === prop
    ) {
      // `{ list }` shorthand — equivalent to `{ list: list }`. Resolve
      // the same-named local binding to its function declaration.
      const decl = findLocalFunctionDecl(property.getNameNode());
      if (decl === null) {
        return null;
      }
      return { func: decl, name: prop };
    }
  }
  return null;
}

function findLocalFunctionDecl(idNode: Node): FunctionRoot | null {
  if (!Node.isIdentifier(idNode)) {
    return null;
  }
  const symbol = idNode.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    if (Node.isFunctionDeclaration(decl)) {
      return decl;
    }
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init === undefined) {
        continue;
      }
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        return init as FunctionRoot;
      }
    }
  }
  return null;
}

function findLocalObjectLiteral(idNode: Node): ObjectLiteralExpression | null {
  if (!Node.isIdentifier(idNode)) {
    return null;
  }
  const symbol = idNode.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init !== undefined && Node.isObjectLiteralExpression(init)) {
        return init;
      }
    }
  }
  return null;
}
