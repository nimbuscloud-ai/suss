/**
 * Finds the SAM or CloudFormation template above a source file and
 * indexes its Serverless::Function handlers by module path, so discovery
 * can map a handler export back to the routes that reach it.
 *
 * @suss/manifest-aws parses the template and its nested stacks. This
 * module walks up the filesystem to the template and turns `CodeUri` and
 * `Handler` into an absolute module path.
 */

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

/** A Serverless::Function's handler and the events that reach it. */
export interface HandlerEntry {
  /**
   * The function's logical id, qualified by the stack path that reaches
   * its document, so a function declared in a nested stack points at the
   * same deployed Lambda the declared side does.
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

// A run reads a handful of templates for thousands of source files, so
// these stay memoized for the process. Walking and parsing per file would
// dominate the run. `clearTemplateCache` resets them between tests.
const dirToTemplate = new Map<string, string | null>();
const templateToIndex = new Map<string, HandlerIndex>();
// Every document a template's index was read from, the nested stacks it
// embeds included, so the cache key can hash all of them.
const templateToDocuments = new Map<string, string[]>();

export function clearTemplateCache(): void {
  dirToTemplate.clear();
  templateToIndex.clear();
  templateToDocuments.clear();
}

/**
 * Every directory on the way up is memoized to the result, so sibling
 * files under the same service need one map lookup.
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
 * A malformed template is reported on stderr and cached as an empty
 * index, so one bad manifest does not stop the extraction.
 */
function indexForTemplate(templatePath: string): HandlerIndex {
  const cached = templateToIndex.get(templatePath);
  if (cached !== undefined) {
    return cached;
  }

  const index: HandlerIndex = new Map();
  const documents = new Set<string>([templatePath]);
  try {
    const tree = loadTemplateTree(templatePath);
    for (const document of tree.documents) {
      documents.add(document.path);
    }
    for (const stack of tree.unfollowed) {
      process.stderr.write(
        `[suss] aws-lambda: ${unfollowedStackMessage(stack)}\n`,
      );
      // A missing or broken child still goes into the cache key, so the
      // run after somebody fixes it reads the fix.
      if (stack.templatePath !== null) {
        documents.add(stack.templatePath);
      }
    }
    for (const document of tree.documents) {
      // A child's CodeUri is relative to the child's own file, and its
      // AppSync resolvers refer to resources in the same document.
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
  templateToDocuments.set(templatePath, [...documents]);
  return index;
}

function toModulePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved);
  return ext === "" ? resolved : resolved.slice(0, -ext.length);
}

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

/**
 * The handlers the nearest template declares for this source file, or an
 * empty array when no template covers it. A handler matches when its
 * `CodeUri` and `Handler` module resolve to the file's path without its
 * extension.
 */
export function handlersForFile(filePath: string): HandlerEntry[] {
  const templatePath = findTemplate(path.dirname(path.resolve(filePath)));
  if (templatePath === null) {
    return [];
  }
  const index = indexForTemplate(templatePath);
  return index.get(toModulePath(filePath)) ?? [];
}

/**
 * Every template the run will read for these files: the one each file
 * resolves to, plus the nested stacks that template embeds. The adapter
 * hashes them into the cache key, so a template edited between two runs
 * gets read again instead of the first run's answer coming back.
 *
 * This walks and parses the same templates discovery is about to, and
 * both are memoized for the process, so the second pass costs nothing.
 */
export function templatesForFiles(files: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const templatePath = findTemplate(path.dirname(path.resolve(file)));
    if (templatePath !== null) {
      roots.add(templatePath);
    }
  }

  const documents = new Set<string>();
  for (const root of roots) {
    indexForTemplate(root);
    for (const document of templateToDocuments.get(root) ?? [root]) {
      documents.add(document);
    }
  }
  return [...documents];
}
