// registrationTemplate.ts (discovery handler): expand a single
// helper-call into N virtual route registrations using pack-author
// templates. Each template substitutes positional arguments via
// `{N}` placeholders; the synthesized DiscoveredUnit gets
// `routeInfo` so the adapter pipeline picks up the REST binding
// directly (same path the decoratedRoute handler uses).
//
// A handler argument is written `{N}` or `{N}.prop`. Which function
// is there goes to the fact layer, so a helper given a name, an
// imported object or a re-exported one reads the same as one handed a
// function written at the call. A computed property name and a chain
// deeper than one property are still unread, and a registration whose
// handler nothing reaches emits no unit.

import path from "node:path";

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import { joinMountedPath } from "@suss/resolution";

import { nodeId } from "../facts/extract.js";
import { ResolutionStore } from "../facts/store.js";
import { declarationsBehind } from "../resolve/unfollowedCall.js";
import { callsResolvingTo } from "./importedCalls.js";
import {
  type MountPrefixIndex,
  registrationSubjectsOf,
  subjectNodeFor,
} from "./registrationCall.js";
import {
  functionValueOf,
  objectLiteralOf,
  propertyValueOf,
} from "./resolveValue.js";

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
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  for (const node of helperCallsOf(sourceFile, match, resolution)) {
    const args = node.getArguments();
    const subject = subjectOfCall(sourceFile, args, match, resolution);
    const prefix =
      subject === undefined
        ? ""
        : (mountPrefixes?.effectivePrefixFor(subject) ?? "");

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
        ...(subject === undefined
          ? {}
          : { registrationSubjectId: nodeId(subject) }),
        routeInfo: {
          method: reg.method.toUpperCase(),
          path: prefix === "" ? path : joinMountedPath(prefix, path),
        },
      });
    }
  }

  return results;
}

/**
 * The routable this call handed the helper. Without it a route the
 * helper writes shares no creation site with the app, and the
 * middleware registered there would not reach it.
 */
function subjectOfCall(
  sourceFile: SourceFile,
  args: Node[],
  match: TemplateMatch,
  resolution: ResolutionStore | undefined,
): Node | undefined {
  const stated = match.subject;
  const argument = stated === undefined ? undefined : args[stated.argument];
  if (stated === undefined || argument === undefined) {
    return undefined;
  }
  for (const importName of stated.importNames) {
    const found = subjectNodeFor(
      argument,
      registrationSubjectsOf(
        sourceFile,
        stated.importModule,
        importName,
        resolution,
      ),
      { importModule: stated.importModule, importName },
      resolution,
    );
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The helper calls this file makes.
 *
 * With no importModule narrowing the helper is matched by name wherever
 * it came from. A package name goes to the store, which follows the
 * callee to that package's export through aliases and barrels. A path
 * the pack already resolved against the config file is a file in this
 * project, and the store's origin rules only speak about packages, so
 * that one is matched against where the callee is declared.
 */
function helperCallsOf(
  sourceFile: SourceFile,
  match: TemplateMatch,
  resolution: ResolutionStore | undefined,
): CallExpression[] {
  const module = match.importModule;
  if (module !== undefined && !path.isAbsolute(module)) {
    const store = resolution ?? new ResolutionStore();
    return callsResolvingTo(sourceFile, store, {
      module,
      name: match.helperName,
    }).filter(Node.isCallExpression);
  }

  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== match.helperName) {
      return;
    }
    if (module === undefined || declaredInModule(callee, module)) {
      calls.push(node);
    }
  });
  return calls;
}

/**
 * Whether the callee is declared in the file at `module`, following an
 * import through to whatever it is an alias of.
 */
function declaredInModule(callee: Node, module: string): boolean {
  return declarationsBehind(callee.getSymbol()).some((declaration) =>
    isModuleFile(declaration.getSourceFile().getFilePath(), module),
  );
}

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

/** A module path points at a file however that file's name ends. */
function isModuleFile(filePath: string, module: string): boolean {
  const withoutExtension = filePath.replace(SOURCE_EXTENSION, "");
  const named = module.replace(SOURCE_EXTENSION, "");
  return withoutExtension === named || withoutExtension === `${named}/index`;
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
      // Non-literal arg in a path slot: return null so caller can
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
 * What to call the handler an argument refers to. A name is used
 * where there is one; a function written out at the call has none, and
 * the kind is what a unit discovered here has carried since this
 * handler was written.
 */
function handlerName(value: Node): string {
  return Node.isIdentifier(value) ? value.getText() : value.getKindName();
}

/**
 * The function a named property of an argument is set to. The argument is
 * an object literal at the call site, a name bound to one, or one built
 * in another module, and the fact layer covers all three.
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

/** The name an object literal writes a property under. */
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
