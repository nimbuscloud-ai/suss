// graphqlClientConstruction.ts: find the GraphQL client constructions
// a pack describes and read the endpoint each one is built with.

import picomatch from "picomatch";
import { Node, type SourceFile } from "ts-morph";

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
  if (sole === null && scopes.length === 0) {
    return;
  }

  const workspace = sole !== null ? boundWorkspaceFor(sole, packs) : null;
  const soleClient =
    sole !== null ? (workspace !== null ? { ...sole, workspace } : sole) : null;
  for (const summary of summaries) {
    if (!isGraphqlOperationBinding(summary.identity.boundaryBinding)) {
      continue;
    }

    const scoped = scopedWorkspaceFor(summary.location.file, scopes);
    const client =
      scoped !== null
        ? { uri: null, uriRef: null, workspace: scoped }
        : soleClient;
    if (client === null) {
      continue;
    }

    const existing = readGraphqlMetadata(summary) ?? {};
    summary.metadata = withGraphqlMetadata(summary.metadata, {
      ...existing,
      client,
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
