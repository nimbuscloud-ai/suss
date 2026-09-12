// graphqlClientConstruction.ts: find the GraphQL client constructions
// a pack describes and read the endpoint each one is built with.

import picomatch from "picomatch";
import {
  type CallExpression,
  type NewExpression,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph";

import {
  isGraphqlOperationBinding,
  readGraphqlMetadata,
  withGraphqlMetadata,
} from "@suss/behavioral-ir";

import { ResolutionStore } from "../facts/store.js";
import { callsByOriginName } from "./importedCalls.js";
import { namedImportsOf } from "./importScan.js";
import {
  objectLiteralOf,
  propertyValueOf,
  stringValueOf,
  writtenNodeOf,
} from "./resolveValue.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

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
      registry = fragmentRegistryStatus(sourceFiles, packs, resolution);
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

  const store = resolution ?? new ResolutionStore();
  const refs: GraphqlClientRef[] = [];
  for (const sourceFile of sourceFiles) {
    for (const spec of specs) {
      const constructions = callsByOriginName(
        sourceFile,
        store,
        spec.importModule,
        new Set([spec.importName]),
      );
      for (const node of constructions.keys()) {
        const found = constructionRef(node, spec.uriProperty, resolution);
        if (found !== null) {
          refs.push(found);
        }
      }
    }
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
  resolution: ResolutionStore | undefined,
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
          statuses.push(
            constructionRegistryStatus(node, registrySpec, resolution),
          );
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
  construction: NewExpression | CallExpression,
  spec: FragmentRegistrySpec,
  resolution: ResolutionStore | undefined,
): FragmentRegistryStatus {
  const options = firstArgumentObject(construction, resolution);
  if (options === null) {
    return "unknown";
  }

  const cacheProperty = options.getProperty(spec.cacheProperty);
  const cacheExpr =
    cacheProperty === undefined ? null : propertyValueOf(cacheProperty);
  if (cacheExpr === null) {
    return "unknown";
  }

  const cache = writtenNodeOf(cacheExpr, resolution);
  if (cache === null || !isConstructionOfClass(cache, spec.cacheConstructor)) {
    return "unknown";
  }

  if (cache.getArguments().length === 0) {
    return "absent";
  }

  const cacheOptions = firstArgumentObject(cache, resolution);
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

/** The object a construction is given as its first argument, written there or named. */
function firstArgumentObject(
  construction: NewExpression | CallExpression,
  resolution: ResolutionStore | undefined,
): ObjectLiteralExpression | null {
  const arg = construction.getArguments()[0];
  return arg === undefined ? null : objectLiteralOf(arg, resolution);
}

/** Whether this expression constructs the class the pack declares. */
function isConstructionOfClass(
  node: Node,
  cacheClass: { importModule: string; importName: string },
): node is NewExpression | CallExpression {
  const local = localImportName(
    node.getSourceFile(),
    cacheClass.importModule,
    cacheClass.importName,
  );
  return local !== null && isConstructionNamed(node, local);
}

function isConstructionNamed(
  node: Node,
  localName: string,
): node is NewExpression | CallExpression {
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
  for (const one of namedImportsOf(sourceFile, [importModule], {
    subpaths: true,
  })) {
    if (one.canonical === importName) {
      return one.local;
    }
  }
  return null;
}

function constructionRef(
  node: NewExpression | CallExpression,
  uriProperty: string,
  resolution: ResolutionStore | undefined,
): GraphqlClientRef | null {
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
