/**
 * Evidence for drafting a graphql-ruby `extends-base` dependency stub:
 * every `require`/`require_relative` of the asked package, and every
 * project class whose superclass is spelled from it. Discovery
 * only recognizes a class through `baseClassNames`' literal names (see
 * discovery.ts's `reachesConfiguredBase`), so a project's own base
 * under a renamed namespace, or one that extends the library's own
 * class directly, has to state the exact name.
 */

import fs from "node:fs";
import path from "node:path";

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, rangeOf, readCallArgs, stringLiteralValue } from "./ast.js";
import { parseRuby } from "./parser.js";
import { findRubyFiles } from "./project.js";
import { walkClasses } from "./scope.js";

import type { RbNode } from "./parser.js";

export interface RubyRequireSite {
  target: string;
  file: string;
  line: number;
}

export interface RubyExtendsSite {
  className: string;
  superclassName: string;
  file: string;
  line: number;
}

export interface RubyStubEvidence {
  requires: RubyRequireSite[];
  extendsSites: RubyExtendsSite[];
}

export interface RubyStubEvidenceOptions {
  packageName: string;
  directory: string;
}

/** Letters only, so "acme-graphql", "acme_graphql" and "AcmeGraphql" all compare equal. */
function bareLetters(name: string): string {
  return name.replaceAll(/[-_]/g, "").toLowerCase();
}

/**
 * Whether a superclass's own top-level constant is the gem's name,
 * cased and split up the way a Ruby constant is. Rails' own
 * underscore convention breaks on a run of capitals like "GraphQL",
 * so this compares letters only rather than reusing that convention.
 */
function isSpelledFrom(qualifiedName: string, packageName: string): boolean {
  const root = qualifiedName.split("::")[0] ?? qualifiedName;
  return bareLetters(root) === bareLetters(packageName);
}

/** Bundler requires a gem under its name with every hyphen turned to an underscore, unless a Gemfile line says otherwise. */
function isPackageRequire(target: string, packageName: string): boolean {
  const bundlerName = packageName.replaceAll("-", "_");
  return (
    target === bundlerName ||
    target.startsWith(`${bundlerName}/`) ||
    target === packageName ||
    target.startsWith(`${packageName}/`)
  );
}

function requireTarget(node: RbNode): string | null {
  if (
    node.type !== "call" ||
    field(node, "receiver") !== null ||
    (field(node, "method")?.text !== "require" &&
      field(node, "method")?.text !== "require_relative")
  ) {
    return null;
  }
  const { positional } = readCallArgs(field(node, "arguments"));
  return positional[0] === undefined ? null : stringLiteralValue(positional[0]);
}

/** Every `require`/`require_relative` in the file, wherever it is written. */
function requireSitesIn(root: RbNode, file: string): RubyRequireSite[] {
  const found: RubyRequireSite[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const target = requireTarget(node);
      if (target !== null) {
        found.push({ target, file, line: rangeOf(node).start });
      }
    },
    into: (node) => (node.type === "argument_list" ? SKIP_CHILDREN : null),
  });
  return found;
}

/** Every class declaration in the file whose superclass is spelled from the package. */
function extendsSitesIn(
  root: RbNode,
  file: string,
  packageName: string,
): RubyExtendsSite[] {
  const found: RubyExtendsSite[] = [];
  walkClasses(root, (info) => {
    if (
      info.superclassQualifiedName !== null &&
      isSpelledFrom(info.superclassQualifiedName, packageName)
    ) {
      found.push({
        className: info.qualifiedName,
        superclassName: info.superclassQualifiedName,
        file,
        line: rangeOf(info.node).start,
      });
    }
  });
  return found;
}

export async function rubyStubEvidence(
  options: RubyStubEvidenceOptions,
): Promise<RubyStubEvidence> {
  const requires: RubyRequireSite[] = [];
  const extendsSites: RubyExtendsSite[] = [];
  for (const file of findRubyFiles(options.directory)) {
    const source = fs.readFileSync(file, "utf8");
    const tree = await parseRuby(source);
    const displayPath = path.relative(options.directory, file);
    for (const site of requireSitesIn(tree.rootNode, displayPath)) {
      if (isPackageRequire(site.target, options.packageName)) {
        requires.push(site);
      }
    }
    extendsSites.push(
      ...extendsSitesIn(tree.rootNode, displayPath, options.packageName),
    );
  }
  return { requires, extendsSites };
}
