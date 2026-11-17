/**
 * The shared groups a run's test files define, and where each one is
 * included. RSpec's `shared_examples "x"` is written once, often in a
 * support file, and `it_behaves_like "x"` in a spec runs its examples
 * there. An include finds its shared group by name, in its own file
 * first and then anywhere in the run. `@suss/recognize` says what each
 * file writes, and the index keeps it across files for the reader.
 *
 * A name read inside a shared group that the group does not define
 * comes from whoever includes it. The value facts key such a name on
 * the shared group, and `emitSharedGroupBinds` binds it to what each
 * include site has under that name. Two includers that give it two
 * values leave it unsettled, since which one ran is not known.
 */

import { sharedGroupsWritten } from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import {
  bySourceOrder,
  isObserved,
  noteKeyRead,
  noteLookup,
} from "@suss/resolution";

import { rubyModuleOps } from "./declaredDiscovery.js";
import { factSourceOf } from "./factSource.js";
import { nodeId } from "./facts/values.js";
import { groupScope } from "./testCases.js";
import { nodeOfResolutionKey } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { CallOps } from "@suss/extractor";
import type {
  SharedGroupInclude,
  SharedGroups,
  SharedGroupsWritten,
} from "@suss/recognize";
import type { RbTestCases } from "./pack.js";
import type { RbNode } from "./parser.js";

interface SharedDefinition {
  readonly file: string;
  /** The key of the call that writes it. */
  readonly site: string;
}

interface IncludeSite {
  readonly file: string;
  readonly site: string;
  readonly call: RbNode;
  /** The keys of the groups and shared groups around the include, outermost first. */
  readonly groups: readonly string[];
  readonly groupCalls: readonly RbNode[];
  /** Whether the shared examples run in a group of their own, as `it_behaves_like` runs them. */
  readonly nested: boolean;
  readonly definition: SharedDefinition;
  readonly definitionCall: RbNode;
}

/** The node at each key, or null when one has none in the run. */
function nodesAt(keys: readonly string[], db: Database): RbNode[] | null {
  const nodes = keys.map((key) => nodeOfResolutionKey(key, db));
  return nodes.every((node) => node !== null) ? (nodes as RbNode[]) : null;
}

/** Whether the file's text has the name of a call that writes or includes a shared group. */
function mentionsSharedGroups({ root, pattern }: PatternedFile): boolean {
  const shared = pattern.cases.calls?.shared;
  const names = [
    ...(shared?.names ?? []),
    ...(shared?.includes ?? []).map((one) => one.method),
  ];
  const text = root.text;
  return names.some((name) => text.includes(name));
}

function keyedDefinitions(
  definitions: SharedGroupsWritten["definitions"],
): { readonly site: string; readonly title: string }[] {
  return definitions.flatMap(({ call, title }) => {
    const site = call.site?.();
    return site === undefined ? [] : [{ site, title }];
  });
}

/** A test file and the pattern that reads it. */
export interface PatternedFile {
  readonly file: string;
  readonly root: RbNode;
  readonly pattern: RbTestCases;
}

export class SharedGroupIndex implements SharedGroups {
  private readonly definitions = new Map<string, SharedDefinition[]>();
  private readonly definitionsBySite = new Map<string, SharedDefinition>();
  private readonly sitesBySite = new Map<string, IncludeSite>();
  private readonly sitesByDefinition = new Map<string, IncludeSite[]>();
  private readonly sitesByFile = new Map<string, IncludeSite[]>();
  private readonly filesByTree = new WeakMap<object, string>();

  constructor(
    private readonly db: Database,
    files: readonly PatternedFile[],
  ) {
    const source = factSourceOf(db);
    // Most spec files write no shared group and no include, and reading
    // one makes the ops for every call it writes.
    const written = files.filter(mentionsSharedGroups).map((one) => ({
      file: one.file,
      ...sharedGroupsWritten(
        one.pattern.cases,
        rubyModuleOps(one.root, one.file, db, source),
      ),
    }));
    for (const { file, root } of files) {
      this.filesByTree.set(root.tree, file);
    }
    for (const { file, definitions } of written) {
      for (const { site, title } of keyedDefinitions(definitions)) {
        const definition = { file, site };
        this.definitions.set(title, [
          ...(this.definitions.get(title) ?? []),
          definition,
        ]);
        this.definitionsBySite.set(site, definition);
      }
    }
    for (const { file, includes } of written) {
      for (const include of includes) {
        this.recordInclude(file, include);
      }
    }
  }

  /** The shared group the include at this site reads, noting its file for the cache, or null when it reads none the run defines. */
  includedAt(include: string): CallOps | null {
    const site = this.sitesBySite.get(include) ?? null;
    if (site === null) {
      return null;
    }
    noteKeyRead(this.db, site.definition.file);
    return factCallOps(site.definition.site, factSourceOf(this.db));
  }

  defines(site: string): boolean {
    return this.definitionsBySite.has(site);
  }

  /** Each include of the shared group, noting the list for the cache, so a run reads the shared group again when its includers change. */
  includersOf(definition: string): readonly SharedGroupInclude[] {
    const sites = this.sitesByDefinition.get(definition) ?? [];
    if (isObserved(this.db)) {
      noteLookup(
        this.db,
        `sharedIncluders:${definition}`,
        sites.map((site) => site.site).join(";"),
      );
    }
    const source = factSourceOf(this.db);
    return sites.flatMap((site) => {
      const call = factCallOps(site.site, source);
      const groups = site.groups.flatMap(
        (group) => factCallOps(group, source) ?? [],
      );
      return call === null ? [] : [{ call, groups }];
    });
  }

  /** The include sites one file writes, in source order. */
  sitesIn(file: string): readonly IncludeSite[] {
    return this.sitesByFile.get(file) ?? [];
  }

  /** The file a node from a test or support file is written in. */
  fileOf(node: RbNode): string | null {
    return this.filesByTree.get(node.tree) ?? null;
  }

  private recordInclude(
    file: string,
    include: SharedGroupsWritten["includes"][number],
  ): void {
    const site = include.call.site?.();
    const found = this.definitions.get(include.title) ?? [];
    const inFile = found.filter((one) => one.file === file);
    const [definition, ...others] = inFile.length > 0 ? inFile : found;
    const groups = include.groups.flatMap((group) => group.site?.() ?? []);
    // The binds read each call's own statements, so a site is kept with its nodes.
    const nodes =
      site === undefined || definition === undefined
        ? null
        : nodesAt([site, definition.site, ...groups], this.db);
    const [call, definitionCall, ...groupCalls] = nodes ?? [];
    if (
      site === undefined ||
      definition === undefined ||
      others.length > 0 ||
      call === undefined ||
      definitionCall === undefined
    ) {
      return;
    }
    const recorded: IncludeSite = {
      file,
      site,
      call,
      groups,
      groupCalls,
      nested: include.nests,
      definition,
      definitionCall,
    };
    this.sitesBySite.set(site, recorded);
    this.sitesByDefinition.set(definition.site, [
      ...(this.sitesByDefinition.get(definition.site) ?? []),
      recorded,
    ]);
    this.sitesByFile.set(
      file,
      [...(this.sitesByFile.get(file) ?? []), recorded].sort((a, b) =>
        bySourceOrder(a.site, b.site),
      ),
    );
  }
}

/**
 * Binds each name a shared group reads to what each include site has
 * under that name, and each name a shared group defines, when it is
 * included in place, to the including group. An include's own block
 * comes first, then the groups around it from the nearest out.
 */
export function emitSharedGroupBinds(
  db: Database,
  index: SharedGroupIndex,
  files: readonly PatternedFile[],
): void {
  for (const at of files) {
    for (const site of index.sitesIn(at.file)) {
      emitSiteBinds(db, index, site, at.pattern);
    }
  }
}

function emitSiteBinds(
  db: Database,
  index: SharedGroupIndex,
  site: IncludeSite,
  pattern: RbTestCases,
): void {
  const defined = groupScope(site.definitionCall, pattern).values;
  for (const [name, value] of visibleAt(index, site, pattern)) {
    if (!defined.has(name)) {
      db.add("binds", [`${site.definition.site}#${name}`, value]);
    }
  }
  const including = site.groups[site.groups.length - 1];
  if (site.nested || including === undefined) {
    return;
  }
  for (const [name, block] of defined) {
    db.add("binds", [
      `${including}#${name}`,
      nodeId(site.definition.file, block),
    ]);
  }
}

/** Each name an include site can read, with the key of what gives it, nearest first. */
function visibleAt(
  index: SharedGroupIndex,
  site: IncludeSite,
  pattern: RbTestCases,
): Map<string, string> {
  const found = new Map<string, string>();
  const scopes = [site.call, ...[...site.groupCalls].reverse()];
  for (const scopeCall of scopes) {
    const file = index.fileOf(scopeCall) ?? site.file;
    const scopeKey = nodeId(file, scopeCall);
    const scope = groupScope(scopeCall, pattern);
    for (const [name, block] of scope.values) {
      if (!found.has(name)) {
        found.set(name, nodeId(file, block));
      }
    }
    if (scope.described !== null && !found.has(pattern.describedClass)) {
      found.set(
        pattern.describedClass,
        `${scopeKey}:${pattern.describedClass}`,
      );
    }

    if (scope.described !== null && !found.has(pattern.subjectValue)) {
      const implicit = `${scopeKey}:${pattern.subjectValue}`;
      found.set(pattern.subjectValue, implicit);
      found.set(pattern.expectations.onSubject, implicit);
    }
  }
  return found;
}
