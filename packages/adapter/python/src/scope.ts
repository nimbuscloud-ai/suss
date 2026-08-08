/**
 * The lexical binder. It builds module, class, and function scopes over one
 * file's parse tree and records how each name in each scope came to be bound,
 * whether that was an import, an assignment, a def, a parameter, or a `global`
 * or `nonlocal` redirect to another scope.
 *
 * It never has to be complete, because "I could not resolve this name" is a
 * legal answer everywhere a name is read. What it has to avoid is being wrong.
 * So it only binds names written directly in a body's own statement list. A
 * definition or import nested inside an `if`, `try`, or `with` block is not
 * found, and a read of it comes back unresolved rather than as a guess.
 */

import {
  bodyStatements,
  field,
  fields,
  isType,
  stripDecorators,
} from "./ast.js";

import type { PyNode } from "./parser.js";

export type ScopeKind = "module" | "class" | "function";

export interface Scope {
  kind: ScopeKind;
  /** The module node, or the class_definition / function_definition this scope belongs to. */
  node: PyNode;
  parent: Scope | null;
  bindings: Map<string, Binding>;
}

/**
 * `relativeLevel` is 0 for an absolute import and the dot count for a
 * relative one. `module` is the dotted path after the dots, empty for
 * a bare `from . import c`.
 */
export type Binding =
  | { kind: "import"; module: string; relativeLevel: number; localName: string }
  | {
      kind: "importFrom";
      module: string;
      relativeLevel: number;
      importedName: string;
    }
  | { kind: "classDef"; node: PyNode }
  | { kind: "functionDef"; node: PyNode }
  | { kind: "parameter" }
  /** The right-hand side, when there is one, so we can trace a decorator's base object one hop back to whatever constructed it. */
  | { kind: "assignment"; value: PyNode | null }
  /** `global x` inside a function: reads of `x` in this scope resolve in the module scope instead. */
  | { kind: "global" }
  /** `nonlocal x` inside a function: reads of `x` resolve in the nearest enclosing function scope. */
  | { kind: "nonlocal" };

export interface ModuleBinding {
  moduleScope: Scope;
  /** The scope a class_definition, a function_definition, or the module node opens, keyed by that node's id. */
  scopeFor: Map<number, Scope>;
  /** The modules a `from X import *` pulls in. We cannot list what a wildcard brings in, so nothing expands them here. */
  openImports: string[];
}

export function bindModule(root: PyNode): ModuleBinding {
  const scopeFor = new Map<number, Scope>();
  const openImports: string[] = [];
  const moduleScope: Scope = {
    kind: "module",
    node: root,
    parent: null,
    bindings: new Map(),
  };
  scopeFor.set(root.id, moduleScope);
  bindBody(root, moduleScope, scopeFor, openImports);
  return { moduleScope, scopeFor, openImports };
}

interface BinderContext {
  scopeFor: Map<number, Scope>;
  openImports: string[];
}

/**
 * A `global` or `nonlocal` that already claimed the name wins. It can be written
 * before or after the assignment that would otherwise rebind the name locally,
 * and either way the assignment goes to the scope the declaration points at
 * rather than shadowing it.
 */
function bindName(scope: Scope, name: string, binding: Binding): void {
  const existing = scope.bindings.get(name);
  if (existing?.kind === "global" || existing?.kind === "nonlocal") {
    return;
  }
  scope.bindings.set(name, binding);
}

function bindBody(
  bodyOwner: PyNode,
  scope: Scope,
  scopeFor: Map<number, Scope>,
  openImports: string[],
): void {
  const ctx: BinderContext = { scopeFor, openImports };
  for (const stmt of bodyStatements(bodyOwner)) {
    bindStatement(stmt, scope, ctx);
  }
}

const STATEMENT_BINDERS: Record<
  string,
  (stmt: PyNode, scope: Scope, ctx: BinderContext) => void
> = {
  import_statement: bindImportStatement,
  import_from_statement: bindImportFromStatement,
  decorated_definition: bindDecoratedDefinition,
  function_definition: bindFunctionDefinition,
  class_definition: bindClassDefinition,
  expression_statement: bindExpressionStatement,
  global_statement: bindGlobalStatement,
  nonlocal_statement: bindNonlocalStatement,
};

function bindStatement(stmt: PyNode, scope: Scope, ctx: BinderContext): void {
  const binder = STATEMENT_BINDERS[stmt.type];
  binder?.(stmt, scope, ctx);
}

function bindImportStatement(stmt: PyNode, scope: Scope): void {
  for (const nameNode of fields(stmt, "name")) {
    if (nameNode.type === "aliased_import") {
      const dotted = field(nameNode, "name");
      const alias = field(nameNode, "alias");
      if (dotted !== null && alias !== null) {
        bindName(scope, alias.text, {
          kind: "import",
          module: dotted.text,
          relativeLevel: 0,
          localName: alias.text,
        });
      }
      continue;
    }
    if (nameNode.type === "dotted_name") {
      // `import a.b.c` binds only the top-level package name `a`.
      const first = nameNode.namedChild(0);
      if (first !== null) {
        bindName(scope, first.text, {
          kind: "import",
          module: nameNode.text,
          relativeLevel: 0,
          localName: first.text,
        });
      }
    }
  }
}

/** Dot count and the dotted path after the dots, for a relative_import node. */
function relativeImportParts(node: PyNode): {
  relativeLevel: number;
  module: string;
} {
  let relativeLevel = 0;
  let module = "";
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "import_prefix") {
      relativeLevel += child.text.length;
      continue;
    }
    if (child.type === "dotted_name") {
      module = child.text;
    }
  }
  return { relativeLevel, module };
}

function bindImportFromStatement(
  stmt: PyNode,
  scope: Scope,
  ctx: BinderContext,
): void {
  const moduleNode = field(stmt, "module_name");
  if (moduleNode === null) {
    return;
  }
  const { module, relativeLevel } =
    moduleNode.type === "relative_import"
      ? relativeImportParts(moduleNode)
      : { module: moduleNode.text, relativeLevel: 0 };

  const hasWildcard = stmt.namedChildren.some(
    (child) => child !== null && child.type === "wildcard_import",
  );
  if (hasWildcard) {
    ctx.openImports.push(
      relativeLevel > 0 ? `${".".repeat(relativeLevel)}${module}` : module,
    );
    return;
  }

  for (const nameNode of fields(stmt, "name")) {
    if (nameNode.type === "aliased_import") {
      const original = field(nameNode, "name");
      const alias = field(nameNode, "alias");
      if (original !== null && alias !== null) {
        bindName(scope, alias.text, {
          kind: "importFrom",
          module,
          relativeLevel,
          importedName: original.text,
        });
      }
      continue;
    }
    if (nameNode.type === "dotted_name") {
      bindName(scope, nameNode.text, {
        kind: "importFrom",
        module,
        relativeLevel,
        importedName: nameNode.text,
      });
    }
  }
}

function bindDecoratedDefinition(
  stmt: PyNode,
  scope: Scope,
  ctx: BinderContext,
): void {
  const { definition } = stripDecorators(stmt);
  bindStatement(definition, scope, ctx);
}

function bindFunctionDefinition(
  stmt: PyNode,
  scope: Scope,
  ctx: BinderContext,
): void {
  const nameNode = field(stmt, "name");
  if (nameNode !== null) {
    bindName(scope, nameNode.text, { kind: "functionDef", node: stmt });
  }
  const functionScope: Scope = {
    kind: "function",
    node: stmt,
    parent: scope,
    bindings: new Map(),
  };
  ctx.scopeFor.set(stmt.id, functionScope);

  const parametersNode = field(stmt, "parameters");
  if (parametersNode !== null) {
    bindParameters(parametersNode, functionScope);
  }

  const bodyNode = field(stmt, "body");
  if (bodyNode !== null) {
    bindBody(bodyNode, functionScope, ctx.scopeFor, ctx.openImports);
  }
}

function bindParameters(parametersNode: PyNode, functionScope: Scope): void {
  for (const param of parametersNode.namedChildren) {
    if (param === null) {
      continue;
    }
    const name = parameterName(param);
    if (name !== null) {
      bindName(functionScope, name, { kind: "parameter" });
    }
  }
}

function parameterName(param: PyNode): string | null {
  if (isType(param, "identifier")) {
    return param.text;
  }
  if (
    isType(
      param,
      "typed_parameter",
      "list_splat_pattern",
      "dictionary_splat_pattern",
    )
  ) {
    // A typed_parameter's name is an unnamed identifier child, since its only
    // field is `type`. Splat patterns wrap it the same way.
    const inner = param.namedChildren.find(
      (child) => child !== null && child.type === "identifier",
    );
    return inner?.text ?? null;
  }
  if (isType(param, "default_parameter", "typed_default_parameter")) {
    const nameNode = field(param, "name");
    return nameNode?.type === "identifier" ? nameNode.text : null;
  }
  return null;
}

function bindClassDefinition(
  stmt: PyNode,
  scope: Scope,
  ctx: BinderContext,
): void {
  const nameNode = field(stmt, "name");
  if (nameNode !== null) {
    bindName(scope, nameNode.text, { kind: "classDef", node: stmt });
  }
  const classScope: Scope = {
    kind: "class",
    node: stmt,
    parent: scope,
    bindings: new Map(),
  };
  ctx.scopeFor.set(stmt.id, classScope);

  const bodyNode = field(stmt, "body");
  if (bodyNode !== null) {
    bindBody(bodyNode, classScope, ctx.scopeFor, ctx.openImports);
  }
}

function bindExpressionStatement(stmt: PyNode, scope: Scope): void {
  const assignment = stmt.namedChildren.find(
    (child) => child !== null && child.type === "assignment",
  );
  if (assignment === undefined || assignment === null) {
    return;
  }
  const left = field(assignment, "left");
  if (left === null) {
    return;
  }
  // An unpacking target such as `a, b = ...` has no identifier on the left, so
  // we leave it unbound.
  if (left.type === "identifier") {
    bindName(scope, left.text, {
      kind: "assignment",
      value: field(assignment, "right"),
    });
  }
}

function bindGlobalStatement(stmt: PyNode, scope: Scope): void {
  for (const child of stmt.namedChildren) {
    if (child !== null && child.type === "identifier") {
      scope.bindings.set(child.text, { kind: "global" });
    }
  }
}

function bindNonlocalStatement(stmt: PyNode, scope: Scope): void {
  for (const child of stmt.namedChildren) {
    if (child !== null && child.type === "identifier") {
      scope.bindings.set(child.text, { kind: "nonlocal" });
    }
  }
}

function moduleScopeOf(scope: Scope): Scope {
  let current = scope;
  while (current.parent !== null) {
    current = current.parent;
  }
  return current;
}

/**
 * Python does not put a class body's namespace on the lookup chain of a function
 * nested inside it, so a class scope's own bindings only count when the search
 * starts there. A `global` or `nonlocal` marker sends the lookup to the scope it
 * points at.
 */
export function resolveName(scope: Scope, name: string): Binding | null {
  let current: Scope | null = scope;
  let first = true;
  while (current !== null) {
    if (current.kind !== "class" || first) {
      const binding = current.bindings.get(name);
      if (binding !== undefined) {
        if (binding.kind === "global") {
          return moduleScopeOf(scope).bindings.get(name) ?? null;
        }
        if (binding.kind === "nonlocal") {
          return resolveNonlocal(current, name);
        }
        return binding;
      }
    }
    first = false;
    current = current.parent;
  }
  return null;
}

function resolveNonlocal(scope: Scope, name: string): Binding | null {
  let current = scope.parent;
  while (current !== null) {
    if (current.kind === "function") {
      const binding = current.bindings.get(name);
      if (
        binding !== undefined &&
        binding.kind !== "nonlocal" &&
        binding.kind !== "global"
      ) {
        return binding;
      }
    }
    current = current.parent;
  }
  return null;
}
