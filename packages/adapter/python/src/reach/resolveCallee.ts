/**
 * What a call's callee is, read through the binder and the import
 * facts: a function in this run the walk can step into, or a reason it
 * cannot. A name is followed only through a binding that says where it
 * came from, so a name that could be two definitions is a stop rather
 * than a guess. The package README lists the spellings that are
 * followed and the ones that stop.
 */

import { field } from "../ast.js";
import { resolveModule } from "../moduleResolver.js";
import { resolveName } from "../scope.js";

import type { UnfollowedReason } from "@suss/behavioral-ir";
import type { PyNode } from "../parser.js";
import type { BoundPythonFile } from "../routers.js";
import type { Binding, Scope } from "../scope.js";

/** A function in this run, and the export path its summary gets. */
export interface ReachedFunction {
  readonly file: BoundPythonFile;
  /** The `function_definition` node. */
  readonly node: PyNode;
  readonly name: string;
  /** `[name]` for a module function, `[Class, name]` for a method. */
  readonly exportPath: string[];
}

export type CalleeResolution =
  | { readonly kind: "followed"; readonly target: ReachedFunction }
  | { readonly kind: "stopped"; readonly reason: UnfollowedReason };

/** What one dotted name came to, one segment at a time. */
type Resolved =
  | { kind: "function"; target: ReachedFunction }
  | { kind: "class"; file: BoundPythonFile; node: PyNode }
  | { kind: "module"; file: BoundPythonFile }
  | {
      kind: "package";
      dotted: string;
      relativeLevel: number;
      from: BoundPythonFile;
    }
  | { kind: "stop"; reason: UnfollowedReason };

export interface ResolveContext {
  /** Every file this run read, by absolute path. */
  readonly filesByPath: ReadonlyMap<string, BoundPythonFile>;
  readonly roots: string[];
}

/** Where a call is written: the file, the binder's scope there, and the function whose body it is. */
export interface CallSite {
  readonly file: BoundPythonFile;
  readonly scope: Scope;
  /** Names the walk saw rebound on the way in, by a loop, a `with`, a lambda, and the like. */
  readonly rebound: ReadonlySet<string>;
}

const stop = (reason: UnfollowedReason): Resolved => ({ kind: "stop", reason });

const MODULE_STOP: Record<"ambiguous" | "outsideRoots", UnfollowedReason> = {
  ambiguous: "multipleSources",
  outsideRoots: "outsideRun",
};

export function resolveCallee(
  call: PyNode,
  site: CallSite,
  ctx: ResolveContext,
): CalleeResolution {
  const callee = field(call, "function");
  if (callee === null) {
    return { kind: "stopped", reason: "noDeclaration" };
  }
  return asCallee(resolveExpression(callee, site, ctx), ctx);
}

/** Calling a class runs its `__init__`; a module, a package, or a function's result is nothing this run can step into. */
function asCallee(resolved: Resolved, ctx: ResolveContext): CalleeResolution {
  if (resolved.kind === "function") {
    return { kind: "followed", target: resolved.target };
  }
  if (resolved.kind === "class") {
    return asCallee(
      memberOfClass(resolved.file, resolved.node, "__init__", ctx),
      ctx,
    );
  }
  if (resolved.kind === "stop") {
    return { kind: "stopped", reason: resolved.reason };
  }
  if (resolved.kind === "package") {
    return { kind: "stopped", reason: "outsideRun" };
  }
  return { kind: "stopped", reason: "noDeclaration" };
}

const EXPRESSION_RESOLVERS: Record<
  string,
  (node: PyNode, site: CallSite, ctx: ResolveContext) => Resolved
> = {
  identifier: (node, site, ctx) => resolveIdentifier(node.text, site, ctx),
  attribute: (node, site, ctx) => {
    const object = field(node, "object");
    const attribute = field(node, "attribute");
    if (object === null || attribute === null) {
      return stop("noDeclaration");
    }
    return memberOf(resolveExpression(object, site, ctx), attribute.text, ctx);
  },
  // `Service().run()` runs a method on whatever the constructor built.
  call: (node, site, ctx) => {
    const callee = field(node, "function");
    if (callee === null) {
      return stop("noDeclaration");
    }
    const built = resolveExpression(callee, site, ctx);
    return built.kind === "class" ? built : stop("noDeclaration");
  },
  parenthesized_expression: (node, site, ctx) => {
    const inner = node.namedChildren[0];
    return inner === null || inner === undefined
      ? stop("noDeclaration")
      : resolveExpression(inner, site, ctx);
  },
};

function resolveExpression(
  node: PyNode,
  site: CallSite,
  ctx: ResolveContext,
): Resolved {
  const resolver = EXPRESSION_RESOLVERS[node.type];
  return resolver === undefined
    ? stop("noDeclaration")
    : resolver(node, site, ctx);
}

function resolveIdentifier(
  name: string,
  site: CallSite,
  ctx: ResolveContext,
): Resolved {
  // A loop target or a lambda parameter rebinds the name to whatever
  // came through at run time, whatever the binder found further out.
  if (site.rebound.has(name)) {
    return stop("unsettledValue");
  }
  if (isReceiver(name, site.scope)) {
    return receiverClass(site);
  }
  const binding = resolveName(site.scope, name);
  if (binding === null) {
    return throughOpenImports(site.file, name, ctx, new Set());
  }
  return resolveBinding(binding, site.file, site.scope, ctx, new Set());
}

/** `self` or `cls` in a method, which stand for the class the method is written in. */
function isReceiver(name: string, scope: Scope): boolean {
  return (
    (name === "self" || name === "cls") &&
    scope.kind === "function" &&
    scope.parent?.kind === "class"
  );
}

function receiverClass(site: CallSite): Resolved {
  const classScope = site.scope.parent;
  if (classScope === null || classScope === undefined) {
    return stop("noDeclaration");
  }
  return { kind: "class", file: site.file, node: classScope.node };
}

const BINDING_RESOLVERS: {
  [K in Binding["kind"]]: (
    binding: Extract<Binding, { kind: K }>,
    file: BoundPythonFile,
    scope: Scope,
    ctx: ResolveContext,
    visited: Set<string>,
  ) => Resolved;
} = {
  functionDef: (binding, file) => ({
    kind: "function",
    target: reachedFunction(file, binding.node),
  }),
  classDef: (binding, file) => ({ kind: "class", file, node: binding.node }),
  parameter: () => stop("callerSupplied"),
  // `import a.b.c` binds `a`, and `import a.b.c as m` binds `m` to `a.b.c`.
  import: (binding, file, _scope, ctx) =>
    moduleNamed(
      file,
      binding.localName === binding.module.split(".")[0]
        ? binding.localName
        : binding.module,
      0,
      ctx,
    ),
  importFrom: (binding, file, _scope, ctx, visited) =>
    memberOf(
      moduleNamed(file, binding.module, binding.relativeLevel, ctx),
      binding.importedName,
      ctx,
      visited,
    ),
  // `run = load` is an alias worth one hop; anything else is a value.
  assignment: (binding, file, scope, ctx, visited) =>
    aliasedValue(binding.value, file, scope, ctx, visited),
  global: () => stop("unsettledValue"),
  nonlocal: () => stop("unsettledValue"),
};

function resolveBinding(
  binding: Binding,
  file: BoundPythonFile,
  scope: Scope,
  ctx: ResolveContext,
  visited: Set<string>,
): Resolved {
  const resolver = BINDING_RESOLVERS[binding.kind] as (
    binding: Binding,
    file: BoundPythonFile,
    scope: Scope,
    ctx: ResolveContext,
    visited: Set<string>,
  ) => Resolved;
  return resolver(binding, file, scope, ctx, visited);
}

function aliasedValue(
  value: PyNode | null,
  file: BoundPythonFile,
  scope: Scope,
  ctx: ResolveContext,
  visited: Set<string>,
): Resolved {
  if (value === null) {
    return stop("unsettledValue");
  }
  if (value.type === "identifier") {
    const binding = resolveName(scope, value.text);
    if (binding === null || binding.kind === "assignment") {
      return stop("unsettledValue");
    }
    return resolveBinding(binding, file, scope, ctx, visited);
  }
  if (value.type === "call") {
    // `svc = Service()` puts an instance in the name, and a method
    // called on it is the class's own.
    const callee = field(value, "function");
    const built =
      callee === null
        ? stop("unsettledValue")
        : aliasedValue(callee, file, scope, ctx, visited);
    return built.kind === "class" ? built : stop("unsettledValue");
  }
  if (value.type === "attribute") {
    const object = field(value, "object");
    const attribute = field(value, "attribute");
    if (object === null || attribute === null) {
      return stop("unsettledValue");
    }
    return memberOf(
      aliasedValue(object, file, scope, ctx, visited),
      attribute.text,
      ctx,
    );
  }
  return stop("unsettledValue");
}

function reachedFunction(
  file: BoundPythonFile,
  node: PyNode,
  owner?: PyNode,
): ReachedFunction {
  const name = field(node, "name")?.text ?? "<anon>";
  const ownerName = owner === undefined ? null : field(owner, "name")?.text;
  return {
    file,
    node,
    name,
    exportPath:
      ownerName === null || ownerName === undefined
        ? [name]
        : [ownerName, name],
  };
}

function moduleNamed(
  from: BoundPythonFile,
  module: string,
  relativeLevel: number,
  ctx: ResolveContext,
): Resolved {
  const resolution = resolveModule(
    from.file,
    { module, relativeLevel },
    { roots: ctx.roots },
  );
  // A dotted name with no file of its own may still head a package
  // without an `__init__.py`, so its members are looked for as modules.
  if (resolution.status !== "resolved") {
    return resolution.reason === "external"
      ? { kind: "package", dotted: module, relativeLevel, from }
      : stop(MODULE_STOP[resolution.reason]);
  }
  const file = ctx.filesByPath.get(resolution.file);
  // A module on disk that this run was not given to read is as far away
  // as a dependency.
  return file === undefined ? stop("outsideRun") : { kind: "module", file };
}

/** `.attr` on whatever came before it. */
function memberOf(
  base: Resolved,
  name: string,
  ctx: ResolveContext,
  visited: Set<string> = new Set(),
): Resolved {
  if (base.kind === "module") {
    return memberOfModule(base.file, name, ctx, visited);
  }
  if (base.kind === "package") {
    return moduleNamed(
      base.from,
      base.dotted === "" ? name : `${base.dotted}.${name}`,
      base.relativeLevel,
      ctx,
    );
  }
  if (base.kind === "class") {
    return memberOfClass(base.file, base.node, name, ctx);
  }
  if (base.kind === "stop") {
    return base;
  }
  return stop("noDeclaration");
}

function memberOfClass(
  file: BoundPythonFile,
  classNode: PyNode,
  name: string,
  ctx: ResolveContext,
): Resolved {
  const classScope = file.module.scopeFor.get(classNode.id);
  const binding = classScope?.bindings.get(name);
  if (binding === undefined) {
    return stop("noDeclaration");
  }
  if (binding.kind === "functionDef") {
    return {
      kind: "function",
      target: reachedFunction(file, binding.node, classNode),
    };
  }
  return resolveBinding(binding, file, classScope as Scope, ctx, new Set());
}

/**
 * What `module.name` refers to: a definition of the module's own,
 * something it imported, a submodule of the package it heads, or a
 * definition one of its wildcard imports brought in.
 */
function memberOfModule(
  file: BoundPythonFile,
  name: string,
  ctx: ResolveContext,
  visited: Set<string>,
): Resolved {
  const key = `${file.file}#${name}`;
  if (visited.has(key)) {
    return stop("unsettledValue");
  }
  visited.add(key);

  const binding = file.module.moduleScope.bindings.get(name);
  if (binding !== undefined) {
    return resolveBinding(binding, file, file.module.moduleScope, ctx, visited);
  }
  if (file.file.endsWith("__init__.py")) {
    const submodule = moduleNamed(file, name, 1, ctx);
    if (submodule.kind === "module") {
      return submodule;
    }
  }
  return throughOpenImports(file, name, ctx, visited);
}

/**
 * A `from x import *` brings in whatever `x` defines, so a name nothing
 * else declares is looked for in every module the file opened. One
 * definition is followed; two leave the call undecided.
 */
function throughOpenImports(
  file: BoundPythonFile,
  name: string,
  ctx: ResolveContext,
  visited: Set<string>,
): Resolved {
  const found: Resolved[] = [];
  for (const spec of file.module.openImports) {
    const dots = spec.length - spec.replace(/^\.+/, "").length;
    const opened = moduleNamed(file, spec.slice(dots), dots, ctx);
    if (opened.kind !== "module") {
      continue;
    }
    const member = memberOfModule(opened.file, name, ctx, visited);
    if (member.kind !== "stop") {
      found.push(member);
    }
  }
  if (found.length > 1) {
    return stop("multipleSources");
  }
  return found[0] ?? stop("noDeclaration");
}
