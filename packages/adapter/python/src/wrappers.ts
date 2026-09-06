/**
 * The project functions a library runs around a route, read from where
 * they are registered: a dependency on a route's parameter or decorator,
 * a dependency list on the app or a router, a function decorated with
 * `@app.middleware(...)` or `@app.exception_handler(...)`. Each one
 * becomes a unit of its own, and every route it reaches lists it, so the
 * extractor can fold its outcomes into the route's. The README says which
 * registrations are read and which are not.
 *
 * A registration on the app reaches every route of the pack in the run,
 * since an app is one per run for every pack that has one. A registration
 * on a router reaches the routes decorated on that same router object,
 * and nothing mounted onto it.
 */

import { absentReading, walkDescendants } from "@suss/extractor";

import { field, rangeOf, spanOf, stripDecorators } from "./ast.js";
import { decoratorReceiver, readCallArguments } from "./decorators.js";
import {
  bodyContentOf,
  recognizedBodyEffects,
  returnBranch,
} from "./discovery.js";
import { bodyTerminals, enumerateBodyBranches } from "./paths/bodyBranches.js";
import {
  bodyCalls,
  enclosingStatement,
  invocationEffects,
} from "./paths/effects.js";
import { raisedResponses } from "./paths/raisedResponses.js";
import { resolveNamedFunctionArgument } from "./reach/resolveCallee.js";
import { constructionOf } from "./routers.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, RawCodeStructure } from "@suss/extractor";
import type { DecoratorClassification } from "./decorators.js";
import type {
  PyDecoratedWrapperForm,
  PyDependencyForm,
  PythonDiscoveryPattern,
  PythonPack,
  PyWrapperForm,
  PyWrapperRegistrar,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { BodyTerminal, TerminalBranch } from "./paths/bodyBranches.js";
import type { ReachedFunction } from "./reach/resolveCallee.js";
import type { BoundPythonFile } from "./routers.js";
import type { ModuleBinding, Scope } from "./scope.js";
import type { StorageLookup } from "./storage.js";

export interface WrapperIndexOptions {
  packs: readonly PythonPack[];
  roots: string[];
  facts: Database | undefined;
  storageFor: (file: BoundPythonFile) => StorageLookup | undefined;
}

/** The route asking which wrappers reach it: the decorator it was found by, and where that decorator was read. */
export interface RouteWrapperQuery {
  pack: PythonPack;
  pattern: PythonDiscoveryPattern;
  /** The absolute path of the file the route is written in. */
  file: string;
  module: ModuleBinding;
  classification: DecoratorClassification;
  definitionNode: PyNode;
}

/** A wrapper the index has a unit for, and the form it was registered through. */
interface Registered {
  reference: WrapperReference;
  form: PyWrapperForm;
}

interface FormOf {
  pack: PythonPack;
  pattern: PythonDiscoveryPattern;
  form: PyWrapperForm;
}

export function buildWrapperIndex(
  files: readonly BoundPythonFile[],
  options: WrapperIndexOptions,
): PythonWrapperIndex {
  const forms = declaredForms(options.packs);
  const filesByPath = new Map(files.map((file) => [file.file, file]));
  const index = new PythonWrapperIndex(options, filesByPath);
  if (forms.length > 0) {
    for (const file of files) {
      for (const declared of forms) {
        registerFrom(file, declared, index);
      }
    }
  }
  return index;
}

function declaredForms(packs: readonly PythonPack[]): FormOf[] {
  return packs.flatMap((pack) =>
    pack.discovery.flatMap((pattern) =>
      (pattern.wrappers ?? []).map((form) => ({ pack, pattern, form })),
    ),
  );
}

/** What every registration in the run reaches, asked once per route and then once per file for the wrapper units. */
export class PythonWrapperIndex {
  /** By pack name: what the app registered, in the order the forms are declared and then the order the files were read. */
  private readonly everyRoute = new Map<string, Registered[]>();
  /** By construction key: what a router or a blueprint registered. */
  private readonly ownRoutes = new Map<string, Registered[]>();
  private readonly unitsByKey = new Map<string, RawCodeStructure>();
  private readonly unitsByFile = new Map<string, RawCodeStructure[]>();

  constructor(
    readonly options: WrapperIndexOptions,
    readonly filesByPath: ReadonlyMap<string, BoundPythonFile>,
  ) {}

  register(
    covers:
      | { kind: "everyRoute"; pack: string }
      | { kind: "ownRoutes"; key: string },
    target: ReachedFunction,
    declared: FormOf,
  ): void {
    const registered = this.registered(target, declared);
    const table =
      covers.kind === "everyRoute" ? this.everyRoute : this.ownRoutes;
    const key = covers.kind === "everyRoute" ? covers.pack : covers.key;
    const list = table.get(key) ?? [];
    list.push(registered);
    table.set(key, list);
  }

  /** The unit for a function, built once however many registrations point at it. */
  registered(target: ReachedFunction, declared: FormOf): Registered {
    const span = spanOf(target.node);
    const key = `${target.file.file}:${span.start}-${span.end}`;
    if (!this.unitsByKey.has(key)) {
      const unit = wrapperUnit(target, declared, this.options);
      this.unitsByKey.set(key, unit);
      const inFile = this.unitsByFile.get(target.file.file) ?? [];
      inFile.push(unit);
      this.unitsByFile.set(target.file.file, inFile);
    }
    return {
      reference: {
        file: target.file.displayPath,
        name: target.name,
        ...(isThrowForm(declared.form) ? { onThrow: true } : {}),
      },
      form: declared.form,
    };
  }

  wrappersFor(query: RouteWrapperQuery): WrapperReference[] {
    const file = this.filesByPath.get(query.file);
    const forms = (query.pattern.wrappers ?? []).map((form) => ({
      pack: query.pack,
      pattern: query.pattern,
      form,
    }));
    if (file === undefined || forms.length === 0) {
      return [];
    }

    const found: Registered[] = [
      ...(this.everyRoute.get(query.pack.name) ?? []),
      ...this.ownRoutesOf(query),
    ];
    for (const declared of forms) {
      if (declared.form.type !== "dependency") {
        continue;
      }
      const site = {
        file,
        scope: query.module.moduleScope,
        rebound: new Set<string>(),
      };
      const targets = [
        ...decoratorDependencies(query.classification, declared.form),
        ...parameterDependencies(query.definitionNode, declared.form),
      ];
      for (const name of targets) {
        const target = resolveNamedFunctionArgument(name, site, {
          filesByPath: this.filesByPath,
          roots: this.options.roots,
        });
        if (target !== null) {
          found.push(this.registered(target, declared));
        }
      }
    }

    // A wrapper registered twice on the way to a route, on the router and
    // on the route say, runs once at the outer registration.
    const seen = new Set<string>();
    const ordered: WrapperReference[] = [];
    for (const wrapper of [...found].sort(
      (a, b) => runOrder(a.form) - runOrder(b.form),
    )) {
      const key = `${wrapper.reference.file}::${wrapper.reference.name}::${wrapper.reference.onThrow === true}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ordered.push(wrapper.reference);
    }
    return ordered;
  }

  private ownRoutesOf(query: RouteWrapperQuery): Registered[] {
    const objectName = query.classification.objectName;
    if (objectName === null) {
      return [];
    }
    const scope =
      query.classification.objectModule?.moduleScope ??
      query.module.moduleScope;
    const objectFile =
      query.classification.objectModule === undefined
        ? query.file
        : this.fileOfModule(query.classification.objectModule);
    if (objectFile === null) {
      return [];
    }
    for (const form of query.pattern.wrappers ?? []) {
      const match = registrarOf(objectName, scope, {
        pack: query.pack,
        pattern: query.pattern,
        form,
      });
      if (match !== null && match.registrar.covers === "ownRoutes") {
        return (
          this.ownRoutes.get(constructionKey(objectFile, match.call)) ?? []
        );
      }
    }
    return [];
  }

  private fileOfModule(module: ModuleBinding): string | null {
    for (const file of this.filesByPath.values()) {
      if (file.module === module) {
        return file.file;
      }
    }
    return null;
  }

  unitsIn(file: string): RawCodeStructure[] {
    return this.unitsByFile.get(file) ?? [];
  }
}

function isThrowForm(form: PyWrapperForm): boolean {
  return form.type === "decoratedWrapper" && form.throwParam !== undefined;
}

/**
 * Middleware wraps the routing itself, so it runs before any dependency
 * however either was registered. An error handler runs only after the
 * rest has raised. The sort is stable, so within a rank the wrappers keep
 * their registration order.
 */
function runOrder(form: PyWrapperForm): number {
  if (isThrowForm(form)) {
    return 2;
  }
  return form.type === "decoratedWrapper" ? 0 : 1;
}

interface RegistrarMatch {
  registrar: PyWrapperRegistrar;
  call: PyNode;
}

/**
 * The registrar a name was built by, when one of the form's registrars
 * matches: `app` built by `FastAPI(...)`. A registrar's constructor may
 * come from a module the pattern does not otherwise read.
 */
function registrarOf(
  name: string,
  scope: Scope,
  declared: FormOf,
): RegistrarMatch | null {
  const modules = [
    ...declared.pattern.importModule,
    ...declared.form.registrars.flatMap(
      (registrar) => registrar.importModule ?? [],
    ),
  ];
  const construction = constructionOf(name, scope, modules);
  if (construction === null) {
    return null;
  }
  const registrar = declared.form.registrars.find(
    (candidate) => candidate.constructorName === construction.constructorName,
  );
  return registrar === undefined
    ? null
    : { registrar, call: construction.call };
}

function constructionKey(file: string, call: PyNode): string {
  return `${file}#${call.startIndex}`;
}

/** Every registration one file writes, through every form the pack declares. */
function registerFrom(
  file: BoundPythonFile,
  declared: FormOf,
  index: PythonWrapperIndex,
): void {
  const table: Record<PyWrapperForm["type"], () => void> = {
    dependency: () =>
      registerConstructorDependencies(
        file,
        declared,
        declared.form as PyDependencyForm,
        index,
      ),
    decoratedWrapper: () =>
      registerDecorated(
        file,
        declared,
        declared.form as PyDecoratedWrapperForm,
        index,
      ),
  };
  table[declared.form.type]();
}

/**
 * `app = FastAPI(dependencies=[Depends(f)])` and `router =
 * APIRouter(dependencies=[Depends(f)])`, at a module's top level, which
 * is where the router index reads a construction too.
 */
function registerConstructorDependencies(
  file: BoundPythonFile,
  declared: FormOf,
  form: PyDependencyForm,
  index: PythonWrapperIndex,
): void {
  const scope = file.module.moduleScope;
  for (const stmt of file.root.namedChildren) {
    const assignment =
      stmt?.type === "expression_statement"
        ? stmt.namedChildren.find((child) => child?.type === "assignment")
        : undefined;
    const left =
      assignment === undefined || assignment === null
        ? null
        : field(assignment, "left");
    if (left?.type !== "identifier") {
      continue;
    }
    const match = registrarOf(left.text, scope, declared);
    if (match === null) {
      continue;
    }
    const { keywordArgs } = readCallArguments(field(match.call, "arguments"));
    const listed = keywordArgs[form.keyword];
    if (listed === undefined) {
      continue;
    }
    const site = { file, scope, rebound: new Set<string>() };
    for (const name of dependencyNamesIn(listed.node, form)) {
      const target = resolveNamedFunctionArgument(name, site, {
        filesByPath: index.filesByPath,
        roots: index.options.roots,
      });
      if (target !== null) {
        index.register(
          coverageOf(match, file, declared.pack),
          target,
          declared,
        );
      }
    }
  }
}

function coverageOf(
  match: RegistrarMatch,
  file: BoundPythonFile,
  pack: PythonPack,
): { kind: "everyRoute"; pack: string } | { kind: "ownRoutes"; key: string } {
  return match.registrar.covers === "everyRoute"
    ? { kind: "everyRoute", pack: pack.name }
    : { kind: "ownRoutes", key: constructionKey(file.file, match.call) };
}

/** `@app.middleware("http")` and the like, on a function written anywhere in the file. */
function registerDecorated(
  file: BoundPythonFile,
  declared: FormOf,
  form: PyDecoratedWrapperForm,
  index: PythonWrapperIndex,
): void {
  walkDescendants<PyNode, Scope>(file.root, file.module.moduleScope, {
    at: (node, scope) => {
      if (node.type !== "decorated_definition") {
        return;
      }
      const { definition, decorators } = stripDecorators(node);
      if (definition.type !== "function_definition") {
        return;
      }
      for (const decorator of decorators) {
        const receiver = decoratorReceiver(decorator);
        if (
          receiver === null ||
          receiver.attributeName !== form.attribute ||
          receiver.object.type !== "identifier"
        ) {
          continue;
        }
        const match = registrarOf(receiver.object.text, scope, declared);
        const name = field(definition, "name")?.text;
        if (match === null || name === undefined) {
          continue;
        }
        index.register(
          coverageOf(match, file, declared.pack),
          { file, node: definition, name, exportPath: [name] },
          declared,
        );
      }
    },
    into: (node, scope) => file.module.scopeFor.get(node.id) ?? scope,
  });
}

/** The function names inside `[Depends(a), Security(b)]`, or inside one such call on its own. */
function dependencyNamesIn(node: PyNode, form: PyDependencyForm): string[] {
  const calls = node.type === "list" ? node.namedChildren : [node];
  const names: string[] = [];
  for (const call of calls) {
    const name = call === null ? null : dependencyNameOf(call, form);
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}

/** `f` in `Depends(f)`, when the call is to one of the form's callees and the argument is a bare name. */
function dependencyNameOf(node: PyNode, form: PyDependencyForm): string | null {
  if (node.type !== "call") {
    return null;
  }
  const callee = field(node, "function");
  const calleeName =
    callee?.type === "identifier"
      ? callee.text
      : callee?.type === "attribute"
        ? (field(callee, "attribute")?.text ?? null)
        : null;
  if (calleeName === null || !form.callees.includes(calleeName)) {
    return null;
  }
  const first = field(node, "arguments")?.namedChildren[0];
  return first?.type === "identifier" ? first.text : null;
}

/** `dependencies=[Depends(f)]` on the route decorator. */
function decoratorDependencies(
  classification: DecoratorClassification,
  form: PyDependencyForm,
): string[] {
  const listed = classification.keywordArgs[form.keyword];
  return listed === undefined ? [] : dependencyNamesIn(listed.node, form);
}

/** How far into an annotation the search for an injector call goes. `Annotated[T, Depends(f)]` needs three, and the rest is headroom. */
const MAX_ANNOTATION_DEPTH = 6;

/** `user: User = Depends(f)` and `user: Annotated[User, Depends(f)]`, in parameter order. */
function parameterDependencies(
  definitionNode: PyNode,
  form: PyDependencyForm,
): string[] {
  const names: string[] = [];
  const findIn = (node: PyNode | null, depth: number): string | null => {
    if (node === null || depth > MAX_ANNOTATION_DEPTH) {
      return null;
    }
    const direct = dependencyNameOf(node, form);
    if (direct !== null) {
      return direct;
    }
    for (const child of node.namedChildren) {
      const found = findIn(child, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  for (const param of field(definitionNode, "parameters")?.namedChildren ??
    []) {
    if (param === null) {
      continue;
    }
    const inDefault = field(param, "value");
    const found =
      inDefault === null
        ? findIn(field(param, "type"), 0)
        : dependencyNameOf(inDefault, form);
    if (found !== null) {
      names.push(found);
    }
  }
  return names;
}

/**
 * The unit for one wrapper. What a return means depends on the form: a
 * dependency hands on by returning, a middleware hands on by calling its
 * continuation and responds by returning, an error handler responds by
 * returning. A raise is the same outcome it is in a route.
 */
function wrapperUnit(
  target: ReachedFunction,
  declared: FormOf,
  options: WrapperIndexOptions,
): RawCodeStructure {
  const { file, node, name, exportPath } = target;
  const body = field(node, "body");
  const range = rangeOf(node);
  const raised = raisedResponses(body, {
    calls: declared.pattern.responseStatusCalls ?? [],
    module: file.module,
    facts: options.facts,
  });
  const continuations = continuationStatements(node, declared.form);
  const terminals = bodyTerminals(body, raised, continuations);
  const effects = invocationEffects(node);
  const extra = recognizedBodyEffects(
    node,
    file.module,
    options.storageFor(file),
  );
  const delegate = (at: PyNode): TerminalBranch => ({
    terminal: {
      kind: "delegate",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: rangeOf(at),
    },
    location: rangeOf(at),
  });
  const respond = (statement: PyNode): TerminalBranch =>
    returnBranch(statement, {
      pattern: declared.pattern,
      responseShape: { reading: absentReading },
      declaredStatus: {
        reading: absentReading,
        ...(declared.pattern.defaultStatusCode !== undefined
          ? { libraryDefault: declared.pattern.defaultStatusCode }
          : {}),
      },
      module: file.module,
      facts: options.facts,
    });
  const branchOf = (terminal: BodyTerminal): TerminalBranch => {
    if (terminal.type === "raise") {
      return {
        terminal: terminal.terminal,
        location: rangeOf(terminal.statement),
      };
    }
    if (
      terminal.type === "continuation" ||
      returnHandsOn(terminal.statement, declared.form)
    ) {
      return delegate(terminal.statement);
    }
    return respond(terminal.statement);
  };

  const branches: RawBranch[] = enumerateBodyBranches({
    body,
    terminals,
    raised,
    effects,
    branchOf,
    fallthrough: delegate(node),
  }).map((branch) =>
    extra.length === 0 ? branch : { ...branch, extraEffects: extra },
  );

  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "middleware",
      file: file.displayPath,
      range,
      span: spanOf(node),
      exportName: exportPath[0] ?? name,
      exportPath,
    },
    boundaryBinding: null,
    parameters: [],
    branches,
    bodyContent: body === null ? "absent" : bodyContentOf(body),
    dependencyCalls: [],
    declaredContract: null,
  };
}

/** Whether a `return` hands the request on rather than ending it, per the form. */
function returnHandsOn(statement: PyNode, form: PyWrapperForm): boolean {
  if (form.type === "dependency") {
    return true;
  }
  if (form.continuationParam !== undefined || form.throwParam !== undefined) {
    return false;
  }
  if (form.returnedValueResponds === true) {
    const returned = statement.namedChildren[0];
    return (
      returned === undefined || returned === null || returned.type === "none"
    );
  }
  return true;
}

/**
 * The statements that call the continuation parameter, `await
 * call_next(request)` in Starlette middleware. Each one leaves the wrapper
 * for what it wraps, so whatever follows it in the body is not read.
 */
function continuationStatements(node: PyNode, form: PyWrapperForm): PyNode[] {
  if (
    form.type !== "decoratedWrapper" ||
    form.continuationParam === undefined
  ) {
    return [];
  }
  const params = (field(node, "parameters")?.namedChildren ?? []).filter(
    (param): param is PyNode => param !== null,
  );
  const param = params[form.continuationParam];
  const continuation =
    param === undefined
      ? null
      : (field(param, "name")?.text ??
        (param.type === "identifier" ? param.text : null));
  if (continuation === null) {
    return [];
  }

  const body = field(node, "body");
  if (body === null) {
    return [];
  }
  const found: PyNode[] = [];
  for (const call of bodyCalls(body)) {
    const callee = field(call, "function");
    const statement =
      callee?.type === "identifier" && callee.text === continuation
        ? enclosingStatement(call, body)
        : null;
    if (statement !== null) {
      found.push(statement);
    }
  }
  return found;
}
