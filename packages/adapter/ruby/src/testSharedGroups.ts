/**
 * The shared groups a run's test files define, and where each one is
 * included. RSpec's `shared_examples "x"` is written once, often in a
 * support file, and `it_behaves_like "x"` in a spec runs its examples
 * there. An include finds its shared group by name, in its own file
 * first and then anywhere in the run.
 *
 * A name read inside a shared group that the group does not define
 * comes from whoever includes it. The value facts key such a name on
 * the shared group, and `emitSharedGroupBinds` binds it to what each
 * include site has under that name. Two includers that give it two
 * values leave it unsettled, since which one ran is not known.
 */

import { isObserved, noteKeyRead, noteLookup } from "@suss/resolution";
import { literalOf } from "@suss/values";

import { children, field } from "./ast.js";
import { nodeId } from "./facts/values.js";
import {
  firstArgument,
  groupScope,
  roleOf,
  sharedGroupsIn,
  sharedIncludeOf,
} from "./testCases.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { RbTestCases } from "./pack.js";
import type { RbNode } from "./parser.js";

export interface SharedDefinition {
  readonly file: string;
  readonly call: RbNode;
  readonly name: string;
}

export interface IncludeSite {
  readonly file: string;
  readonly call: RbNode;
  /** The groups around the include, outermost first. */
  readonly groups: readonly RbNode[];
  /** Whether the shared examples run in a group of their own, as `it_behaves_like` runs them. */
  readonly nested: boolean;
  readonly definition: SharedDefinition;
}

/** A test file and the pattern that reads it. */
export interface PatternedFile {
  readonly file: string;
  readonly root: RbNode;
  readonly pattern: RbTestCases;
}

/** Values keyed by node, for nodes from any number of files. */
class ByNode<V> {
  private readonly byTree = new WeakMap<object, Map<number, V>>();

  set(node: RbNode, value: V): void {
    const known = this.byTree.get(node.tree) ?? new Map<number, V>();
    this.byTree.set(node.tree, known);
    known.set(node.id, value);
  }

  get(node: RbNode): V | undefined {
    return this.byTree.get(node.tree)?.get(node.id);
  }
}

export class SharedGroupIndex {
  private readonly definitions = new Map<string, SharedDefinition[]>();
  private readonly definitionsByNode = new ByNode<SharedDefinition>();
  private readonly sitesByNode = new ByNode<IncludeSite>();
  private readonly sitesByDefinition = new Map<
    SharedDefinition,
    IncludeSite[]
  >();
  private readonly filesByTree = new WeakMap<object, string>();

  constructor(
    private readonly db: Database,
    files: readonly PatternedFile[],
  ) {
    for (const { file, root, pattern } of files) {
      this.filesByTree.set(root.tree, file);
      for (const call of sharedGroupsIn(root, pattern)) {
        const name = this.nameOf(call);
        if (name === null) {
          continue;
        }
        const definition = { file, call, name };
        this.definitions.set(name, [
          ...(this.definitions.get(name) ?? []),
          definition,
        ]);
        this.definitionsByNode.set(call, definition);
      }
    }
    for (const one of files) {
      this.recordIncludes(one, one.root, []);
    }
  }

  /** The include this call makes, or null when it makes none or names no shared group the run defines. */
  includedAt(call: RbNode): IncludeSite | null {
    const site = this.sitesByNode.get(call) ?? null;
    this.noteRead(site?.definition ?? null);
    return site;
  }

  /** The shared group this call defines, or null. */
  definitionAt(call: RbNode): SharedDefinition | null {
    return this.definitionsByNode.get(call) ?? null;
  }

  includersOf(definition: SharedDefinition): readonly IncludeSite[] {
    const sites = this.sitesByDefinition.get(definition) ?? [];
    if (isObserved(this.db)) {
      noteLookup(
        this.db,
        `sharedIncluders:${nodeId(definition.file, definition.call)}`,
        sites.map((site) => nodeId(site.file, site.call)).join(";"),
      );
    }
    return sites;
  }

  /** The file a node from a test or support file is written in. */
  fileOf(node: RbNode): string | null {
    return this.filesByTree.get(node.tree) ?? null;
  }

  private recordIncludes(
    at: PatternedFile,
    node: RbNode,
    groups: readonly RbNode[],
  ): void {
    for (const child of children(node)) {
      const role = roleOf(child, at.pattern);
      const include = sharedIncludeOf(child, at.pattern);
      if (include !== null && groups.length > 0) {
        this.recordInclude(
          at,
          child,
          groups,
          include.nestedTitle !== undefined,
        );
        continue;
      }
      const opens = role === "opensGroup" || role === "sharedGroup";
      const block = opens ? field(child, "block") : null;
      if (block !== null) {
        this.recordIncludes(at, block, [...groups, child]);
        continue;
      }
      this.recordIncludes(at, child, groups);
    }
  }

  private recordInclude(
    at: PatternedFile,
    call: RbNode,
    groups: readonly RbNode[],
    nested: boolean,
  ): void {
    const name = this.nameOf(call);
    const found = name === null ? [] : (this.definitions.get(name) ?? []);
    const inFile = found.filter((one) => one.file === at.file);
    const [definition, ...others] = inFile.length > 0 ? inFile : found;
    if (definition === undefined || others.length > 0) {
      return;
    }
    const site = { file: at.file, call, groups, nested, definition };
    this.sitesByNode.set(call, site);
    this.sitesByDefinition.set(definition, [
      ...(this.sitesByDefinition.get(definition) ?? []),
      site,
    ]);
  }

  private nameOf(call: RbNode): string | null {
    const first = firstArgument(call);
    return first === null ? null : literalOf(evaluatedValue(first, this.db));
  }

  private noteRead(definition: SharedDefinition | null): void {
    if (definition !== null) {
      noteKeyRead(this.db, definition.file);
    }
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
    for (const site of sitesIn(index, at)) {
      emitSiteBinds(db, index, site, at.pattern);
    }
  }
}

function sitesIn(index: SharedGroupIndex, at: PatternedFile): IncludeSite[] {
  const found: IncludeSite[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const site = index.includedAt(child);
      if (site !== null) {
        found.push(site);
      }
      visit(child);
    }
  };
  visit(at.root);
  return found;
}

function emitSiteBinds(
  db: Database,
  index: SharedGroupIndex,
  site: IncludeSite,
  pattern: RbTestCases,
): void {
  const definition = site.definition;
  const defined = groupScope(definition.call, pattern).values;
  const sharedKey = nodeId(definition.file, definition.call);
  for (const [name, value] of visibleAt(index, site, pattern)) {
    if (!defined.has(name)) {
      db.add("binds", [`${sharedKey}#${name}`, value]);
    }
  }
  const including = site.groups[site.groups.length - 1];
  if (site.nested || including === undefined) {
    return;
  }
  const includingKey = nodeId(index.fileOf(including) ?? site.file, including);
  for (const [name, block] of defined) {
    db.add("binds", [
      `${includingKey}#${name}`,
      nodeId(definition.file, block),
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
  const scopes = [site.call, ...[...site.groups].reverse()];
  for (const scopeCall of scopes) {
    const file = index.fileOf(scopeCall) ?? site.file;
    const scope = groupScope(scopeCall, pattern);
    for (const [name, block] of scope.values) {
      if (!found.has(name)) {
        found.set(name, nodeId(file, block));
      }
    }
    if (scope.described !== null && !found.has(pattern.describedClass)) {
      found.set(
        pattern.describedClass,
        `${nodeId(file, scopeCall)}:${pattern.describedClass}`,
      );
    }

    if (scope.described !== null && !found.has(pattern.subjectValue)) {
      const implicit = `${nodeId(file, scopeCall)}:${pattern.subjectValue}`;
      found.set(pattern.subjectValue, implicit);
      found.set(pattern.expectations.onSubject, implicit);
    }
  }
  return found;
}
