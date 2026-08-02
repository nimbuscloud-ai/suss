// templateIndex.ts — locate the SAM/CFN template reachable from a source
// file and index its Serverless::Function handlers by resolved module
// path.
//
// The manifest parse (loading the template and the children it embeds,
// reading function resources + Events) comes from @suss/manifest-aws —
// this module only
// does the filesystem discovery (walk up to the template) and the
// code-path resolution (CodeUri + Handler → an absolute module path)
// that a framework pack needs to map a handler export back to the
// routes that invoke it.

import fs from "node:fs";
import path from "node:path";

import {
  type AppSyncResolverBinding,
  loadTemplateTree,
  qualifiedLogicalId,
  readAppSyncResolvers,
  readServerlessFunctions,
  type ServerlessHttpRoute,
  type ServerlessNonHttpEvent,
  unfollowedStackMessage,
} from "@suss/manifest-aws";

/** One Serverless::Function's handler + the Events that reach it. */
export interface HandlerEntry {
  /**
   * The function's logical id, qualified by the stack path that reaches
   * its document, so a function declared in a nested stack names the
   * same deployed Lambda the declared side names.
   */
  functionLogicalId: string;
  /**
   * GraphQL fields this handler serves, when the same template declares
   * an AppSync API that routes them here. Empty for a handler nothing
   * in the graph points at.
   */
  graphqlFields: Array<{ typeName: string; fieldName: string }>;
  handler: string;
  exportName: string;
  httpRoutes: ServerlessHttpRoute[];
  nonHttpEvents: ServerlessNonHttpEvent[];
}

/** Map from an absolute, extension-less module path to the handlers it backs. */
export type HandlerIndex = Map<string, HandlerEntry[]>;

// SAM's default template filenames, in the order the CLI resolves them.
const TEMPLATE_NAMES = ["template.yaml", "template.yml", "template.json"];

// Per-directory template resolution (dir → template path or null) and
// per-template parsed index. Process-lifetime memoization: one extraction
// run touches a handful of templates but thousands of source files, so
// re-walking / re-parsing per file would dominate. `clearTemplateCache`
// resets both for test isolation.
const dirToTemplate = new Map<string, string | null>();
const templateToIndex = new Map<string, HandlerIndex>();

export function clearTemplateCache(): void {
  dirToTemplate.clear();
  templateToIndex.clear();
}

/**
 * Walk up from `startDir` to the filesystem root looking for a SAM
 * template. Every directory visited on the way is memoized to the
 * result, so sibling files under the same service resolve in O(1).
 */
function findTemplate(startDir: string): string | null {
  const chain: string[] = [];
  let dir = startDir;
  while (true) {
    const cached = dirToTemplate.get(dir);
    if (cached !== undefined) {
      for (const d of chain) {
        dirToTemplate.set(d, cached);
      }
      return cached;
    }
    chain.push(dir);

    const found =
      TEMPLATE_NAMES.map((name) => path.join(dir, name)).find((candidate) =>
        fs.existsSync(candidate),
      ) ?? null;
    if (found !== null) {
      for (const d of chain) {
        dirToTemplate.set(d, found);
      }
      return found;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const d of chain) {
        dirToTemplate.set(d, null);
      }
      return null;
    }
    dir = parent;
  }
}

/**
 * Parse a template into a handler index keyed by resolved module path.
 * A malformed template is surfaced on stderr and cached as an empty
 * index — the pack never crashes the extraction over a bad manifest.
 */
function indexForTemplate(templatePath: string): HandlerIndex {
  const cached = templateToIndex.get(templatePath);
  if (cached !== undefined) {
    return cached;
  }

  const index: HandlerIndex = new Map();
  try {
    const tree = loadTemplateTree(templatePath);
    for (const stack of tree.unfollowed) {
      process.stderr.write(
        `[suss] aws-lambda: ${unfollowedStackMessage(stack)}\n`,
      );
    }
    for (const document of tree.documents) {
      // A child's CodeUri is written relative to the child's own file,
      // and its AppSync graph names resources in its own document.
      const templateDir = path.dirname(document.path);
      const fieldsByFunction = groupFieldsByFunction(
        readAppSyncResolvers(document.template),
      );
      for (const fn of readServerlessFunctions(document.template)) {
        const resolvedModule = path.resolve(
          templateDir,
          fn.codeUri,
          fn.modulePath,
        );
        const list = index.get(resolvedModule) ?? [];
        list.push({
          functionLogicalId: qualifiedLogicalId(
            document.stackPath,
            fn.logicalId,
          ),
          graphqlFields: fieldsByFunction.get(fn.logicalId) ?? [],
          handler: fn.handler,
          exportName: fn.exportName,
          httpRoutes: fn.httpRoutes,
          nonHttpEvents: fn.nonHttpEvents,
        });
        index.set(resolvedModule, list);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[suss] aws-lambda: failed to read ${templatePath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  templateToIndex.set(templatePath, index);
  return index;
}

/** Drop a source file's extension, returning its absolute module path. */
function toModulePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved);
  return ext === "" ? resolved : resolved.slice(0, -ext.length);
}

/**
 * Handlers declared for the given source file by the template reachable
 * from it, or an empty array when no template covers the file. Matching
 * is by resolved module path (CodeUri + Handler module vs. the file's
 * path without extension).
 */
/**
 * A Lambda can back more than one field, and a field can run more than
 * one Lambda, so this is many to many in both directions.
 */
function groupFieldsByFunction(
  bindings: AppSyncResolverBinding[],
): Map<string, Array<{ typeName: string; fieldName: string }>> {
  const out = new Map<string, Array<{ typeName: string; fieldName: string }>>();
  for (const binding of bindings) {
    for (const logicalId of binding.lambdaFunctionLogicalIds) {
      const fields = out.get(logicalId) ?? [];
      fields.push({ typeName: binding.typeName, fieldName: binding.fieldName });
      out.set(logicalId, fields);
    }
  }
  return out;
}

export function handlersForFile(filePath: string): HandlerEntry[] {
  const templatePath = findTemplate(path.dirname(path.resolve(filePath)));
  if (templatePath === null) {
    return [];
  }
  const index = indexForTemplate(templatePath);
  return index.get(toModulePath(filePath)) ?? [];
}
