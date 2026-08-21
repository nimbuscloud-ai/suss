// graphqlClientConstruction.ts: find the GraphQL client constructions
// a pack describes and read the endpoint each one is built with.

import picomatch from "picomatch";
import { Node, type ObjectLiteralExpression, type SourceFile } from "ts-morph";

import {
  isGraphqlOperationBinding,
  readGraphqlMetadata,
  withGraphqlMetadata,
} from "@suss/behavioral-ir";

import { stringValueOf } from "./resolveValue.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";

export interface GraphqlClientRef {
  /** The endpoint string when the construction wrote a literal. */
  uri: string | null;
  /** The written expression when the value is computed, e.g. an env read. */
  uriRef: string | null;
}

/**
 * Record which service each graphql-operation summary talks to, on
 * `metadata.graphql.client`. A file-scope binding decides per
 * operation; otherwise the project's sole client construction decides
 * for all of them, and a project with two clients and no scopes
 * records nothing.
 *
 * An operation whose document ships a dangling fragment spread also
 * gets `metadata.graphql.fragmentRegistry`, so the checker can say
 * whether anything at run time supplies the missing definition.
 */
export function stampGraphqlClientRefs(
  summaries: BehavioralSummary[],
  sourceFiles: ReadonlyArray<SourceFile>,
  packs: ReadonlyArray<PatternPack>,
  resolution: ResolutionStore | undefined,
): void {
  const scopes = compileOperationScopes(packs);
  const sole = soleGraphqlClientRef(
    collectGraphqlClientRefs(sourceFiles, packs, resolution),
  );

  const workspace = sole !== null ? boundWorkspaceFor(sole, packs) : null;
  const soleClient =
    sole !== null ? (workspace !== null ? { ...sole, workspace } : sole) : null;
  // Walked once, and only when an operation ships a dangling spread.
  let registry: FragmentRegistryStatus | null = null;
  for (const summary of summaries) {
    if (!isGraphqlOperationBinding(summary.identity.boundaryBinding)) {
      continue;
    }

    const existing = readGraphqlMetadata(summary) ?? {};
    const scoped = scopedWorkspaceFor(summary.location.file, scopes);
    const client =
      scoped !== null
        ? { uri: null, uriRef: null, workspace: scoped }
        : soleClient;
    const dangling = (existing.unresolvedFragments?.length ?? 0) > 0;
    if (client === null && !dangling) {
      continue;
    }

    if (dangling && registry === null) {
      registry = fragmentRegistryStatus(sourceFiles, packs);
    }

    summary.metadata = withGraphqlMetadata(summary.metadata, {
      ...existing,
      ...(client !== null ? { client } : {}),
      ...(dangling && registry !== null ? { fragmentRegistry: registry } : {}),
    });
  }
}

interface CompiledScope {
  matches: (file: string) => boolean;
  workspace: string;
}

/**
 * Globs match the file path as recorded on the summary. A written
 * relative glob gets a `**` prefix so `app/frontend/admin/**` matches
 * however deep the project root is in the absolute path.
 */
function compileOperationScopes(
  packs: ReadonlyArray<PatternPack>,
): CompiledScope[] {
  return packs
    .flatMap((pack) => pack.graphqlOperationScopes ?? [])
    .map((scope) => {
      const matchers = scope.files.map((glob) =>
        picomatch(glob.startsWith("/") ? glob : `**/${glob}`, { dot: true }),
      );
      return {
        matches: (file: string) => matchers.some((m) => m(file)),
        workspace: scope.workspace,
      };
    });
}

/** The first matching scope's workspace, or null when none matches. */
function scopedWorkspaceFor(
  file: string,
  scopes: ReadonlyArray<CompiledScope>,
): string | null {
  for (const scope of scopes) {
    if (scope.matches(file)) {
      return scope.workspace;
    }
  }
  return null;
}

/** The provider workspace a pack's per-project config binds this endpoint to, or null when none does. */
function boundWorkspaceFor(
  ref: GraphqlClientRef,
  packs: ReadonlyArray<PatternPack>,
): string | null {
  const key = ref.uri ?? ref.uriRef;
  if (key === null) {
    return null;
  }
  for (const pack of packs) {
    const bound = pack.graphqlClientBindings?.[key];
    if (bound !== undefined) {
      return bound;
    }
  }
  return null;
}

/**
 * Every client construction in the given files, one entry per
 * construction that states the pack-declared uri property.
 */
export function collectGraphqlClientRefs(
  sourceFiles: ReadonlyArray<SourceFile>,
  packs: ReadonlyArray<PatternPack>,
  resolution: ResolutionStore | undefined,
): GraphqlClientRef[] {
  const specs = packs.flatMap((pack) => pack.graphqlClients ?? []);
  if (specs.length === 0) {
    return [];
  }

  const refs: GraphqlClientRef[] = [];
  for (const sourceFile of sourceFiles) {
    const localNames = localNamesFor(sourceFile, specs);
    if (localNames.size === 0) {
      continue;
    }
    sourceFile.forEachDescendant((node) => {
      const found = constructionRef(node, localNames, resolution);
      if (found !== null) {
        refs.push(found);
      }
    });
  }
  return refs;
}

/**
 * The one client the whole project constructs, or null when there is
 * none or more than one distinct endpoint.
 *
 * Attribution is project-level because a hook call does not say which
 * client it goes through; the client is constructed once and reaches
 * the hook through a provider. One distinct endpoint means every
 * operation gets it; two or more abstain rather than guess.
 */
export function soleGraphqlClientRef(
  refs: ReadonlyArray<GraphqlClientRef>,
): GraphqlClientRef | null {
  const distinct = new Map<string, GraphqlClientRef>();
  for (const ref of refs) {
    distinct.set(`${ref.uri ?? ""}|${ref.uriRef ?? ""}`, ref);
  }
  if (distinct.size !== 1) {
    return null;
  }
  return [...distinct.values()][0] ?? null;
}

export type FragmentRegistryStatus = "configured" | "absent" | "unknown";

interface FragmentRegistrySpec {
  cacheProperty: string;
  cacheConstructor: { importModule: string; importName: string };
  registryProperty: string;
}

/**
 * Whether the project's client constructions install a fragment
 * registry, read from the option chain a pack declares (the client's
 * cache option, the cache constructor, the cache option that installs
 * the registry).
 *
 * The rule: "absent" is a claim about the run, so it is recorded only
 * when at least one construction was found and every one was read down
 * to a registry-free options object. A client the pack cannot see the
 * construction of, a cache built by a helper it cannot follow, or an
 * options object it cannot read all count as "unknown", never as
 * "absent".
 */
export function fragmentRegistryStatus(
  sourceFiles: ReadonlyArray<SourceFile>,
  packs: ReadonlyArray<PatternPack>,
): FragmentRegistryStatus {
  const statuses: FragmentRegistryStatus[] = [];
  for (const spec of packs.flatMap((pack) => pack.graphqlClients ?? [])) {
    const registrySpec = spec.fragmentRegistry;
    if (registrySpec === undefined) {
      continue;
    }

    for (const sourceFile of sourceFiles) {
      const local = localImportName(
        sourceFile,
        spec.importModule,
        spec.importName,
      );
      if (local === null) {
        continue;
      }
      sourceFile.forEachDescendant((node) => {
        if (isConstructionNamed(node, local)) {
          statuses.push(constructionRegistryStatus(node, registrySpec));
        }
      });
    }
  }
  return combineRegistryStatuses(statuses);
}

function combineRegistryStatuses(
  statuses: ReadonlyArray<FragmentRegistryStatus>,
): FragmentRegistryStatus {
  if (statuses.includes("configured")) {
    return "configured";
  }

  if (statuses.length === 0 || statuses.includes("unknown")) {
    return "unknown";
  }
  return "absent";
}

/** One construction's verdict, from its options object down to the cache's options. */
function constructionRegistryStatus(
  construction: Node,
  spec: FragmentRegistrySpec,
): FragmentRegistryStatus {
  const options = firstArgumentObjectLiteral(construction);
  if (options === null) {
    return "unknown";
  }

  const cacheExpr = propertyValueOf(options, spec.cacheProperty);
  if (cacheExpr === null) {
    return "unknown";
  }

  const cacheConstruction = resolveToConstructionOf(
    cacheExpr,
    spec.cacheConstructor,
  );
  if (cacheConstruction === null) {
    return "unknown";
  }

  if (
    !Node.isNewExpression(cacheConstruction) &&
    !Node.isCallExpression(cacheConstruction)
  ) {
    return "unknown";
  }
  const args = cacheConstruction.getArguments();
  if (args.length === 0) {
    return "absent";
  }

  const cacheOptions = firstArgumentObjectLiteral(cacheConstruction);
  if (cacheOptions === null) {
    return "unknown";
  }

  if (cacheOptions.getProperty(spec.registryProperty) !== undefined) {
    return "configured";
  }

  // A spread could carry the registry option under another name's
  // cover, so a literal with one and without the property stays
  // unread rather than counting as registry-free.
  const hasSpread = cacheOptions
    .getProperties()
    .some((property) => Node.isSpreadAssignment(property));
  return hasSpread ? "unknown" : "absent";
}

/** The construction's first argument when it is a written object literal. */
function firstArgumentObjectLiteral(
  construction: Node,
): ObjectLiteralExpression | null {
  if (
    !Node.isNewExpression(construction) &&
    !Node.isCallExpression(construction)
  ) {
    return null;
  }
  const arg = construction.getArguments()[0];
  if (arg === undefined || !Node.isObjectLiteralExpression(arg)) {
    return null;
  }
  return arg;
}

/** The written value behind a property, shorthand `{ cache }` included. */
function propertyValueOf(
  options: ObjectLiteralExpression,
  name: string,
): Node | null {
  const property = options.getProperty(name);
  if (property === undefined) {
    return null;
  }

  if (Node.isPropertyAssignment(property)) {
    return property.getInitializer() ?? null;
  }

  if (Node.isShorthandPropertyAssignment(property)) {
    // The `{ cache }` identifier's own symbol is the property; the
    // local it forwards comes from the checker.
    const symbol = property
      .getProject()
      .getTypeChecker()
      .getShorthandAssignmentValueSymbol(property);
    return symbol?.getValueDeclaration() ?? null;
  }
  return null;
}

/**
 * Follow an expression to a construction of the declared class:
 * through parentheses and `as` casts, and through local `const cache =
 * new InMemoryCache(...)` bindings one variable at a time. Anything
 * else (a parameter, a helper call, an import whose declaration is not
 * a variable) resolves to null and the caller reports "unknown".
 */
function resolveToConstructionOf(
  expression: Node,
  cacheClass: { importModule: string; importName: string },
): Node | null {
  let current: Node | undefined = expression;
  for (let hop = 0; hop < 4 && current !== undefined; hop += 1) {
    current = unwrapExpression(current);
    if (Node.isVariableDeclaration(current)) {
      current = current.getInitializer();
      continue;
    }

    if (Node.isNewExpression(current) || Node.isCallExpression(current)) {
      const callee = current.getExpression();
      if (callee === undefined || !Node.isIdentifier(callee)) {
        return null;
      }
      const local = localImportName(
        current.getSourceFile(),
        cacheClass.importModule,
        cacheClass.importName,
      );
      return local !== null && callee.getText() === local ? current : null;
    }

    if (!Node.isIdentifier(current)) {
      return null;
    }
    const declaration = current.getSymbol()?.getValueDeclaration();
    if (declaration === undefined || !Node.isVariableDeclaration(declaration)) {
      return null;
    }
    current = declaration.getInitializer();
  }
  return null;
}

function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function isConstructionNamed(node: Node, localName: string): boolean {
  if (!Node.isNewExpression(node) && !Node.isCallExpression(node)) {
    return false;
  }
  const callee = node.getExpression();
  return (
    callee !== undefined &&
    Node.isIdentifier(callee) &&
    callee.getText() === localName
  );
}

/**
 * The local name a file binds to `importName` from `importModule` or
 * one of its subpaths (`@apollo/client` covers `@apollo/client/cache`),
 * alias-aware, or null when the file does not import it.
 */
function localImportName(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
): string | null {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const module = importDecl.getModuleSpecifierValue();
    if (module !== importModule && !module.startsWith(`${importModule}/`)) {
      continue;
    }

    for (const named of importDecl.getNamedImports()) {
      if (named.getName() === importName) {
        return named.getAliasNode()?.getText() ?? named.getName();
      }
    }
  }
  return null;
}

/** Local names the file binds to a declared constructor or factory, with the uri property each looks for. */
function localNamesFor(
  sourceFile: SourceFile,
  specs: ReadonlyArray<{
    importModule: string;
    importName: string;
    uriProperty: string;
  }>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const module = importDecl.getModuleSpecifierValue();
    for (const spec of specs) {
      if (module !== spec.importModule) {
        continue;
      }
      for (const named of importDecl.getNamedImports()) {
        if (named.getName() !== spec.importName) {
          continue;
        }
        const local = named.getAliasNode()?.getText() ?? named.getName();
        names.set(local, spec.uriProperty);
      }
    }
  }
  return names;
}

function constructionRef(
  node: Node,
  localNames: ReadonlyMap<string, string>,
  resolution: ResolutionStore | undefined,
): GraphqlClientRef | null {
  if (!Node.isNewExpression(node) && !Node.isCallExpression(node)) {
    return null;
  }
  const callee = node.getExpression();
  if (callee === undefined || !Node.isIdentifier(callee)) {
    return null;
  }
  const uriProperty = localNames.get(callee.getText());
  if (uriProperty === undefined) {
    return null;
  }

  const optionsArg = node.getArguments()[0];
  if (optionsArg === undefined || !Node.isObjectLiteralExpression(optionsArg)) {
    return null;
  }
  const property = optionsArg.getProperty(uriProperty);
  if (property === undefined || !Node.isPropertyAssignment(property)) {
    return null;
  }
  const value = property.getInitializer();
  if (value === undefined) {
    return null;
  }

  const literal = stringValueOf(value, resolution);
  if (literal !== null) {
    return { uri: literal, uriRef: null };
  }
  return { uri: null, uriRef: value.getText() };
}
