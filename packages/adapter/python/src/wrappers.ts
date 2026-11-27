/**
 * The project functions a library runs around a route, read from where
 * they are registered: a dependency on a route's parameter or decorator,
 * a dependency list on the app or a router, or a function decorated with
 * `@app.middleware(...)` or `@app.exception_handler(...)`. Each becomes a
 * unit of its own, and every route it reaches lists it, so the extractor
 * can fold its outcomes into the route's. DESIGN.md, under "What runs
 * around a route", lists which registrations are read.
 *
 * A registration on the app reaches every route of the pack in the run,
 * because the run treats a pack's app as the only one. A registration on
 * a router reaches its own routes, and with a mount call's own list it
 * reaches those below it when each router on the way is mounted once.
 */

import { absentReading } from "@suss/extractor";
import {
  anyOf,
  callbackHandedOver,
  callbackPositions,
  discoverDeclared,
} from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import { noteKeyRead, noteLookup } from "@suss/resolution";

import { aliasValueOf } from "./annotations.js";
import {
  children,
  field,
  parameterNameAndType,
  rangeOf,
  spanOf,
  stripDecorators,
} from "./ast.js";
import { pythonModuleOps } from "./declaredDiscovery.js";
import { classifyDecorator, unwrapDecorator } from "./decorators.js";
import {
  bodyContentOf,
  recognizedBodyEffects,
  returnBranch,
  withBodyEffects,
} from "./discovery.js";
import { factSourceOf } from "./factSource.js";
import { nameKeyIn } from "./facts/values.js";
import {
  bodyTerminals,
  enumerateBodyBranches,
  returnStatements,
} from "./paths/bodyBranches.js";
import {
  bodyCalls,
  enclosingStatement,
  invocationSites,
} from "./paths/effects.js";
import { raisedResponses } from "./paths/raisedResponses.js";
import { functionNamed } from "./reach/resolveCallee.js";
import { nodeOfResolutionKey } from "./values/evaluator.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  DecoratedMatch,
  ModuleOps,
  RawBranch,
  RawCodeStructure,
  ValueOps,
} from "@suss/extractor";
import type { Range } from "./ast.js";
import type { BoundPythonFile } from "./boundFiles.js";
import type { RouteDecorator } from "./discovery.js";
import type { ImportedDefinitionLookup } from "./importedDefinitions.js";
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
import type { DeclaredRouteIndex } from "./routeTables.js";
import type { ModuleBinding } from "./scope.js";
import type { StorageLookup } from "./storage.js";

export interface WrapperIndexOptions {
  packs: readonly PythonPack[];
  roots: string[];
  facts: Database | undefined;
  /** The function each function key was read from. */
  definitions: ReadonlyMap<string, PyNode>;
  storageFor: (file: BoundPythonFile) => StorageLookup | undefined;
  /** Where each router is mounted, so a dependency registered on the way reaches the routes below it. */
  routes?: DeclaredRouteIndex;
  /** Where a name a file imports is defined, so an annotation alias imported from another module can be read. */
  importedDefinition?: ImportedDefinitionLookup;
}

/** The route asking which wrappers reach it: the decorator it was found by, and where that decorator was read. */
export interface RouteWrapperQuery {
  pack: PythonPack;
  pattern: PythonDiscoveryPattern;
  /** The absolute path of the file the route is written in. */
  file: string;
  module: ModuleBinding;
  classification: RouteDecorator;
  definitionNode: PyNode;
}

/** A wrapper the index has a unit for, and the form it was registered through. */
interface Registered {
  reference: WrapperReference;
  form: PyWrapperForm;
}

/** A middleware or an error handler registered on the app, and whether it may replace the response its continuation returned. */
export interface AppWrapper {
  reference: WrapperReference;
  mayReplaceResponse: boolean;
}

/**
 * The closure a project's decorator hands back, read with the route's
 * pattern. It runs the route's function where it calls the decorator's
 * parameter, `continuation`. No pack declares it, so it has no form.
 */
export interface DecoratorClosure {
  pack: PythonPack;
  pattern: PythonDiscoveryPattern;
  continuation: string;
}

/** A wrapper form with the pattern and pack that declare it. */
export interface FormOf {
  pack: PythonPack;
  pattern: PythonDiscoveryPattern;
  form: PyWrapperForm;
}

const EVERY_ROUTE = "wrapEvery ";
const OWN_ROUTES = "wrapOwn ";
const MOUNTED = "wrapMounted ";
const MOUNTED_SEPARATOR = "\u0000";

function describeRegistered(found: readonly Registered[] | undefined): string {
  return (found ?? [])
    .map(
      ({ reference }) =>
        `${reference.file}:${reference.name}:${reference.onThrow === true}`,
    )
    .join(",");
}

export function buildWrapperIndex(
  files: readonly BoundPythonFile[],
  options: WrapperIndexOptions,
): PythonWrapperIndex {
  const forms = declaredForms(options.packs);
  const filesByPath = new Map(files.map((file) => [file.file, file]));
  const index = new PythonWrapperIndex(options, filesByPath);
  const facts = options.facts;
  if (forms.length > 0 && facts !== undefined) {
    for (const file of files) {
      const module = pythonModuleOps(file, facts);
      for (const declared of forms) {
        registerFrom({ file, module, declared, index });
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
  /** By pack name: the app constructions its routes run under. */
  private readonly appCalls = new Map<
    string,
    { call: PyNode; file: string }[]
  >();
  /** By wrapper reference: the parameters a dependency function declares, and its file. */
  private readonly dependencyParameterTable = new Map<
    string,
    { file: string; names: string[]; declaresSource: boolean }
  >();
  private readonly unitsByFile = new Map<string, RawCodeStructure[]>();
  /** The wrapper references whose middleware may send something other than what its continuation returned. */
  private readonly replacing = new Set<string>();
  /** By pattern and router key: whether a form registers on that router for its own routes. */
  private readonly routersAsked = new Map<
    PythonDiscoveryPattern,
    Map<string, boolean>
  >();
  /**
   * Told about every registration, a pack's form or a project decorator's
   * closure, so a cache can repeat the ones a file's discovery made.
   */
  onRegistered:
    | ((target: ReachedFunction, how: FormOf | DecoratorClosure) => void)
    | null = null;

  constructor(
    readonly options: WrapperIndexOptions,
    readonly filesByPath: ReadonlyMap<string, BoundPythonFile>,
  ) {}

  /**
   * The same lookup `wrappersFor` noted under `id`, made again over this
   * index, or null when `id` is not one of these.
   */
  lookAgain(id: string): string | null {
    if (id.startsWith(EVERY_ROUTE)) {
      return describeRegistered(
        this.everyRoute.get(id.slice(EVERY_ROUTE.length)),
      );
    }
    if (id.startsWith(OWN_ROUTES)) {
      return describeRegistered(
        this.ownRoutes.get(id.slice(OWN_ROUTES.length)),
      );
    }
    if (id.startsWith(MOUNTED)) {
      const [packName, position, key] = id
        .slice(MOUNTED.length)
        .split(MOUNTED_SEPARATOR);
      const pack = this.options.packs.find((one) => one.name === packName);
      const pattern = pack?.discovery[Number(position)];
      return pack === undefined || pattern === undefined || key === undefined
        ? describeRegistered([])
        : describeRegistered(this.registeredAbove(pack, pattern, key));
    }
    return null;
  }

  private noted(
    kind: string,
    key: string,
    found: readonly Registered[] | undefined,
  ): readonly Registered[] {
    const facts = this.options.facts;
    if (facts !== undefined) {
      noteLookup(facts, `${kind}${key}`, describeRegistered(found));
    }
    return found ?? [];
  }

  /**
   * The value a module-level name was assigned, in this file or the one it
   * is imported from, `CurrentUser = Annotated[User, Depends(f)]`, and the
   * file that value is written in.
   */
  aliasValueOf(file: string, name: string): WrittenValue | null {
    const bound = this.filesByPath.get(file);
    if (bound === undefined) {
      return null;
    }
    const alias = aliasValueOf(name, bound.module.moduleScope, {
      importedDefinition: this.options.importedDefinition ?? null,
    });
    return alias === null
      ? null
      : { node: alias.node, file: alias.file ?? file };
  }

  /** The project function a module-level name in this file refers to, or null for anything else. */
  functionCalled(file: string, name: string): ReachedFunction | null {
    if (this.options.facts === undefined) {
      return null;
    }
    return functionNamed(nameKeyIn(file, null, name), {
      filesByPath: this.filesByPath,
      roots: this.options.roots,
      facts: this.options.facts,
      definitions: this.options.definitions,
    });
  }

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
    this.onRegistered?.(target, declared);
    const span = spanOf(target.node);
    const key = `${target.file.file}:${span.start}-${span.end}`;
    if (!this.unitsByKey.has(key)) {
      const unit = wrapperUnit(target, declared, this.options);
      this.unitsByKey.set(key, unit);
      const inFile = this.unitsByFile.get(target.file.file) ?? [];
      inFile.push(unit);
      this.unitsByFile.set(target.file.file, inFile);
    }
    const reference: WrapperReference = {
      file: target.file.displayPath,
      name: target.name,
      ...(isThrowForm(declared.form) ? { onThrow: true } : {}),
    };
    if (mayReplaceResponse(target.node, declared.form, this.options.facts)) {
      this.replacing.add(referenceKey(reference));
    }
    if (declared.form.type === "dependency") {
      this.dependencyParameterTable.set(referenceKey(reference), {
        file: target.file.file,
        names: parameterNamesOf(target.node),
        declaresSource: declaresSourcedParameter(
          target.node,
          Object.keys(declared.pattern.parameterSources ?? {}),
        ),
      });
    }
    return { reference, form: declared.form };
  }

  /**
   * The middleware and error handlers registered on the pack's app by a
   * decorator. The library runs them for a request no route matches too,
   * where a dependency runs only once a route has matched.
   */
  decoratedOnApp(pack: string): AppWrapper[] {
    return (this.everyRoute.get(pack) ?? []).flatMap(({ form, reference }) =>
      form.type === "decoratedWrapper"
        ? [
            {
              reference,
              mayReplaceResponse: this.replacing.has(referenceKey(reference)),
            },
          ]
        : [],
    );
  }

  /**
   * The unit for the closure a project's decorator hands back, built once
   * however many routes the decorator is written on. Its name is what
   * calling the decorator writes, since the decorator may have a summary
   * of its own under its name.
   */
  registeredClosure(
    target: ReachedFunction,
    closure: DecoratorClosure,
  ): WrapperReference {
    this.onRegistered?.(target, closure);
    const span = spanOf(target.node);
    const key = `${target.file.file}:${span.start}-${span.end}`;
    if (!this.unitsByKey.has(key)) {
      const unit = closureUnit(target, closure, this.options);
      this.unitsByKey.set(key, unit);
      const inFile = this.unitsByFile.get(target.file.file) ?? [];
      inFile.push(unit);
      this.unitsByFile.set(target.file.file, inFile);
    }
    return { file: target.file.displayPath, name: target.name };
  }

  /**
   * The parameters the dependencies among these wrappers declare, and
   * whether one is declared through a parameter source such as `Query()`.
   * The library fills those from the request and validates them, the same
   * as parameters the route declares.
   */
  dependencyParameters(references: readonly WrapperReference[]): {
    names: ReadonlySet<string>;
    declaresSource: boolean;
  } {
    const names = new Set<string>();
    let declaresSource = false;
    for (const reference of references) {
      const found = this.dependencyParameterTable.get(referenceKey(reference));
      if (found === undefined) {
        continue;
      }
      if (this.options.facts !== undefined) {
        noteKeyRead(this.options.facts, found.file);
      }
      for (const name of found.names) {
        names.add(name);
      }
      declaresSource ||= found.declaresSource;
    }
    return { names, declaresSource };
  }

  wrappersFor(query: RouteWrapperQuery): WrapperReference[] {
    const file = this.filesByPath.get(query.file);
    const forms = (query.pattern.wrappers ?? []).map((form) => ({
      pack: query.pack,
      pattern: query.pattern,
      form,
    }));
    if (file === undefined) {
      return [];
    }
    const decorators = this.decoratorLayers(query, file);
    if (forms.length === 0) {
      return decorators;
    }

    const own = this.ownRoutesOf(query);
    const found: Registered[] = [
      ...this.noted(
        EVERY_ROUTE,
        query.pack.name,
        this.everyRoute.get(query.pack.name),
      ),
      ...(own === null ? [] : this.mountedAbove(query, own.key)),
      ...(own?.registered ?? []),
    ];
    const decorator = this.callAt(query.classification.key);
    for (const declared of forms) {
      if (declared.form.type !== "dependency") {
        continue;
      }
      const targets = [
        ...dependenciesListed(decorator, declared.form).map((name) => ({
          file: file.file,
          name,
        })),
        ...parameterDependencies(query.definitionNode, declared.form, {
          file: file.file,
          aliasOf: (name) => this.aliasValueOf(file.file, name),
        }),
      ];
      for (const { file: writtenIn, name } of targets) {
        const target = this.functionCalled(writtenIn, name);
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
    // The function's own decorators wrap what the library calls, so they
    // run inside everything registered on the way to it.
    return [
      ...ordered.filter((one) => one.onThrow !== true),
      ...decorators,
      ...ordered.filter((one) => one.onThrow === true),
    ];
  }

  /**
   * The decorators written on the route's function below the one that
   * registers it, outermost first. Each wraps the function the library
   * calls. None has a summary: a library's has no body in the run, and a
   * project's own is not composed into the route yet, so a project
   * decorator goes by what calling it writes, `require_admin(fn)`, which
   * no summary is named. The decorators the packs read, such as the
   * route's own and the namespace's `@ns.doc`, are left out.
   */
  private decoratorLayers(
    query: RouteWrapperQuery,
    file: BoundPythonFile,
  ): WrapperReference[] {
    const decorated = query.definitionNode.parent;
    if (decorated === null || decorated.type !== "decorated_definition") {
      return [];
    }
    const written = stripDecorators(decorated).decorators;
    const routeAt = written.findIndex((decorator) =>
      sameRange(rangeOf(decorator), query.classification.range),
    );
    return written
      .slice(routeAt + 1)
      .flatMap((decorator) => this.decoratorLayer(decorator, query, file));
  }

  private decoratorLayer(
    decorator: PyNode,
    query: RouteWrapperQuery,
    file: BoundPythonFile,
  ): WrapperReference[] {
    const facts = this.options.facts;
    const direct = classifyDecorator(decorator, query.module, facts);
    const written = decoratorCallee(decorator);
    if (
      written === null ||
      (direct.module !== null && readByAPack(direct.module, this.options)) ||
      (direct.objectName !== null &&
        direct.objectName === query.classification.objectName) ||
      unwrapDecorator(decorator, facts) !== null
    ) {
      return [];
    }

    const project =
      written.type === "identifier"
        ? this.functionCalled(file.file, written.text)
        : null;
    if (project !== null) {
      if (facts !== undefined) {
        noteKeyRead(facts, project.file.file);
      }
      return [this.projectDecoratorLayer(project, query)];
    }
    return [{ file: direct.module ?? file.displayPath, name: written.text }];
  }

  /**
   * The layer a project's own decorator puts around the route. When it
   * hands back a closure written inside it that returns what calling the
   * function it was given returns, the closure is summarized and
   * composed into the route. Any other decorator, including one whose
   * closure keeps going after that call, goes by the same name with no
   * summary behind it.
   */
  private projectDecoratorLayer(
    decorator: ReachedFunction,
    query: RouteWrapperQuery,
  ): WrapperReference {
    const continuation = parameterNamesOf(decorator.node)[0] ?? "";
    const name = `${decorator.name}(${continuation})`;
    const closure = closureReturnedBy(decorator.node);
    const handsOn =
      closure === null || continuation === ""
        ? []
        : callsThrough(closure, continuation, this.options.facts);
    if (
      closure === null ||
      handsOn.length === 0 ||
      !handsOn.every((statement) => returnsCallTo(statement, continuation))
    ) {
      return { file: decorator.file.displayPath, name };
    }
    return this.registeredClosure(
      { file: decorator.file, node: closure, name, exportPath: [] },
      { pack: query.pack, pattern: query.pattern, continuation },
    );
  }

  /**
   * What the mounts above the route's router register on the way down:
   * the dependencies an `include_router` call lists, and those of each
   * router it is mounted onto, outermost first, the order they run in.
   */
  private mountedAbove(query: RouteWrapperQuery, key: string): Registered[] {
    const position = query.pack.discovery.indexOf(query.pattern);
    return [
      ...this.noted(
        MOUNTED,
        [query.pack.name, position, key].join(MOUNTED_SEPARATOR),
        this.registeredAbove(query.pack, query.pattern, key),
      ),
    ];
  }

  private registeredAbove(
    pack: PythonPack,
    pattern: PythonDiscoveryPattern,
    key: string,
  ): Registered[] {
    const hops = this.options.routes?.mountsAbove(pattern, key) ?? null;
    if (hops === null) {
      return [];
    }
    const forms = (pattern.wrappers ?? []).flatMap((form) =>
      form.type === "dependency" ? [{ pack, pattern, form }] : [],
    );
    const found: Registered[] = [];
    for (const hop of [...hops].reverse()) {
      found.push(
        ...(hop.parentKey === null
          ? []
          : (this.ownRoutes.get(hop.parentKey) ?? [])),
      );
      for (const declared of forms) {
        for (const name of dependenciesListed(hop.mount, declared.form)) {
          const target = this.functionCalled(hop.file, name);
          if (target !== null) {
            found.push(this.registered(target, declared));
          }
        }
      }
    }
    return found;
  }

  private ownRoutesOf(
    query: RouteWrapperQuery,
  ): { key: string; registered: readonly Registered[] } | null {
    const key = this.ownRouterOf(query);
    return key === null
      ? null
      : {
          key,
          registered: this.noted(OWN_ROUTES, key, this.ownRoutes.get(key)),
        };
  }

  /**
   * The key of the router the route table says a route is declared on,
   * when one of the pattern's forms registers a wrapper on what built it
   * for its own routes: `APIRouter()`, and not the app's `FastAPI()`.
   */
  private ownRouterOf(query: RouteWrapperQuery): string | null {
    const { router } = query.classification;
    const call = router === null ? null : this.callAt(router);
    if (call === null || router === null) {
      return null;
    }
    const facts = this.options.facts;
    if (facts !== undefined) {
      noteKeyRead(facts, call.file?.() ?? router);
    }
    const asked = this.routersAsked.get(query.pattern) ?? new Map();
    this.routersAsked.set(query.pattern, asked);
    const owned =
      asked.get(router) ??
      (query.pattern.wrappers ?? []).some(
        (form) => registrarOf(call, form.registrars)?.covers === "ownRoutes",
      );
    asked.set(router, owned);
    return owned ? router : null;
  }

  /** The call at a key, as the module ops read it. */
  private callAt(key: string): CallOps | null {
    const facts = this.options.facts;
    return facts === undefined ? null : factCallOps(key, factSourceOf(facts));
  }

  /** Records the app a pack's routes run under, for the keywords written on its construction. */
  recordApp(pack: string, call: PyNode, file: string): void {
    const calls = this.appCalls.get(pack) ?? [];
    if (!calls.some((one) => one.call === call)) {
      calls.push({ call, file });
    }
    this.appCalls.set(pack, calls);
  }

  /**
   * Every call that registers something for a route on the way to it:
   * the app's construction, the mount calls and the routers they mount
   * onto, and the route's own router. A caller reads a keyword off each.
   */
  callsAbove(query: RouteWrapperQuery): PyNode[] {
    const own = this.ownRouterOf(query);
    const hops =
      own === null
        ? []
        : (this.options.routes?.mountsAbove(query.pattern, own) ?? []);
    const nodeAt = (key: string | null): PyNode[] => {
      const node =
        key === null ? null : nodeOfResolutionKey(key, this.options.facts);
      return node === null ? [] : [node];
    };
    const files = [
      ...(this.appCalls.get(query.pack.name) ?? []).map((one) => one.file),
      ...hops.map((hop) => hop.file),
    ];
    if (this.options.facts !== undefined) {
      for (const file of files) {
        noteKeyRead(this.options.facts, file);
      }
    }
    return [
      ...(this.appCalls.get(query.pack.name) ?? []).map((one) => one.call),
      ...hops.map((hop) => hop.call),
      ...hops.flatMap((hop) => nodeAt(hop.parentKey)),
      ...nodeAt(own),
    ];
  }

  unitsIn(file: string): RawCodeStructure[] {
    return this.unitsByFile.get(file) ?? [];
  }
}

function referenceKey(reference: WrapperReference): string {
  return `${reference.file}::${reference.name}`;
}

/** Whether a pack in the run reads decorators from this module itself. */
function readByAPack(module: string, options: WrapperIndexOptions): boolean {
  return options.packs.some((pack) =>
    pack.discovery.some((pattern) => pattern.importModule.includes(module)),
  );
}

/** What a decorator calls, `limiter.limit` for `@limiter.limit("5/minute")`. */
function decoratorCallee(decorator: PyNode): PyNode | null {
  const written = decorator.namedChild(0);
  if (written === null) {
    return null;
  }
  return written.type === "call" ? field(written, "function") : written;
}

function sameRange(a: Range, b: Range): boolean {
  return a.start === b.start && a.end === b.end;
}

function parameterNamesOf(definition: PyNode): string[] {
  return children(field(definition, "parameters")).flatMap((parameter) => {
    const named = parameterNameAndType(parameter);
    return named === null ? [] : [named.name];
  });
}

/**
 * Whether a parameter defaults to a call to one of the library's
 * parameter sources, `page: int = Query(1)`. One written inside
 * `Annotated[...]` is not read here.
 */
function declaresSourcedParameter(
  definition: PyNode,
  sources: readonly string[],
): boolean {
  return children(field(definition, "parameters")).some((parameter) => {
    const value = field(parameter, "value");
    const callee = value?.type === "call" ? field(value, "function") : null;
    const name =
      callee?.type === "attribute"
        ? field(callee, "attribute")?.text
        : callee?.text;
    return name !== undefined && sources.includes(name);
  });
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

/**
 * The first of the registrars whose construction the call is,
 * `FastAPI(...)` for the app's, or null for a call none of them makes.
 */
function registrarOf(
  call: CallOps,
  registrars: readonly PyWrapperRegistrar[],
): PyWrapperRegistrar | null {
  return registrars.find((registrar) => call.isFrom(registrar.made)) ?? null;
}

type Coverage =
  | { kind: "everyRoute"; pack: string }
  | { kind: "ownRoutes"; key: string };

function coverageOf(
  registrar: PyWrapperRegistrar,
  construction: CallOps,
  pack: PythonPack,
): Coverage {
  return registrar.covers === "everyRoute"
    ? { kind: "everyRoute", pack: pack.name }
    : { kind: "ownRoutes", key: construction.site?.() ?? "" };
}

/** One file, its module ops, and one form to read its registrations through. */
interface Registering {
  file: BoundPythonFile;
  module: ModuleOps;
  declared: FormOf;
  index: PythonWrapperIndex;
}

/** Every registration one file writes, through every form the pack declares. */
function registerFrom(registering: Registering): void {
  const table: Record<PyWrapperForm["type"], () => void> = {
    dependency: () => registerConstructorDependencies(registering),
    decoratedWrapper: () => registerDecorated(registering),
  };
  table[registering.declared.form.type]();
}

/**
 * `app = FastAPI(dependencies=[Depends(f)])` and `router =
 * APIRouter(dependencies=[Depends(f)])`, for each name the module binds
 * at its top level to a registrar's construction.
 */
function registerConstructorDependencies({
  file,
  module,
  declared,
  index,
}: Registering): void {
  const form = declared.form as PyDependencyForm;
  if (!mentionsARegistrar(module, form.registrars)) {
    return;
  }
  for (const { value } of module.exports()) {
    const call = value.asCall?.() ?? null;
    const registrar = call === null ? null : registrarOf(call, form.registrars);
    const node =
      call === null || registrar === null
        ? null
        : nodeOfResolutionKey(call.site?.() ?? "", index.options.facts);
    if (call === null || registrar === null || node === null) {
      continue;
    }
    if (registrar.covers === "everyRoute") {
      index.recordApp(declared.pack.name, node, file.file);
    }
    for (const name of dependenciesListed(call, form)) {
      const target = index.functionCalled(file.file, name);
      if (target !== null) {
        index.register(
          coverageOf(registrar, call, declared.pack),
          target,
          declared,
        );
      }
    }
  }
}

/** Whether the file's text writes the name of one of the registrars' constructors. */
function mentionsARegistrar(
  module: ModuleOps,
  registrars: readonly PyWrapperRegistrar[],
): boolean {
  return registrars.some((registrar) =>
    (registrar.made.named ?? []).some((name) => module.mentions(name)),
  );
}

/**
 * `@app.middleware("http")` and the like, on a function written anywhere
 * in the file, as the `decorated` member finds it. A registration is read
 * on a name the file binds to a registrar's construction it writes
 * itself, so an app imported from another file, or handed to a function
 * as a parameter, registers nothing here.
 */
function registerDecorated({
  file,
  module,
  declared,
  index,
}: Registering): void {
  const form = declared.form as PyDecoratedWrapperForm;
  for (const unit of discoverDeclared(decoratedMatchOf(form), "", module)) {
    const by = unit.decoratedBy;
    const node = unit.func as PyNode;
    if (
      by === undefined ||
      node.type !== "function_definition" ||
      !builtIn(by.receiver, by.on, file)
    ) {
      continue;
    }
    const registrar = registrarOf(by.on, form.registrars);
    if (registrar === null) {
      continue;
    }
    index.register(
      coverageOf(registrar, by.on, declared.pack),
      { file, node, name: unit.name, exportPath: [unit.name] },
      declared,
    );
  }
}

/** The `decorated` member that finds the form's decorator on any of its registrars. */
function decoratedMatchOf(form: PyDecoratedWrapperForm): DecoratedMatch {
  return {
    type: "decorated",
    on: anyOf(...form.registrars.map((registrar) => registrar.made)),
    named: { [form.attribute]: { kind: "middleware" } },
  };
}

/** Whether the receiver is a name, and the construction it comes to is written in the file. */
function builtIn(
  receiver: ValueOps,
  construction: CallOps,
  file: BoundPythonFile,
): boolean {
  return receiver.form?.() === "name" && construction.file?.() === file.file;
}

/**
 * The functions a list under the form's keyword hands over, `[Depends(a),
 * Security(b)]`, or the one call written there on its own, each read
 * through the pack's callbacks chain.
 */
function dependenciesListed(
  call: CallOps | null,
  form: PyDependencyForm,
): string[] {
  const listed = call?.keywordAt?.(form.keyword) ?? null;
  if (listed === null) {
    return [];
  }
  const alone = listed.asCall?.() ?? null;
  const items = alone === null ? listed.items() : [listed];
  return items.flatMap((item) => {
    const handing = item.asCall?.() ?? null;
    const name = handing === null ? null : functionHandedOver(handing, form);
    return name === null ? [] : [name];
  });
}

/** The name of the function a call hands over, `f` in `Depends(f)`, when the chain takes the call and it hands over a name. */
function functionHandedOver(
  call: CallOps,
  form: PyDependencyForm,
): string | null {
  const handed = callbackHandedOver(form.handedTo, call);
  return handed?.form?.() === "name" ? (handed.source?.() ?? null) : null;
}

/** An expression, and the file it is written in, where the names inside it resolve. */
interface WrittenValue {
  node: PyNode;
  file: string;
}

/**
 * `user: User = Depends(f)`, `user: Annotated[User, Depends(f)]`, and
 * `user: CurrentUser` with `CurrentUser = Annotated[User, Depends(f)]`, in
 * parameter order, each with the file `f` is named in. A parameter's
 * default and annotation state no call facts, so each is read as written,
 * through the chain's methods table.
 */
function parameterDependencies(
  definitionNode: PyNode,
  form: PyDependencyForm,
  where: { file: string; aliasOf: (name: string) => WrittenValue | null },
): { file: string; name: string }[] {
  const handedIn = (node: PyNode): string | null => writtenHandOver(node, form);
  const foundIn = (
    written: WrittenValue | null,
  ): { file: string; name: string }[] => {
    const name = written === null ? null : firstWithin(written.node, handedIn);
    return written === null || name === null
      ? []
      : [{ file: written.file, name }];
  };
  return parameterDefaults(definitionNode).flatMap(({ value, annotation }) => {
    if (value !== null) {
      return foundIn({ node: value, file: where.file });
    }
    const written = foundIn(
      annotation === null ? null : { node: annotation, file: where.file },
    );
    if (written.length > 0) {
      return written;
    }
    const alias = aliasNameOf(annotation);
    return alias === null ? [] : foundIn(where.aliasOf(alias));
  });
}

/** The name an annotation is written as when it is a bare name, `CurrentUser`. */
function aliasNameOf(annotation: PyNode | null): string | null {
  const written =
    annotation?.type === "type"
      ? (children(annotation)[0] ?? null)
      : annotation;
  return written?.type === "identifier" ? written.text : null;
}

/**
 * The name a call written in a parameter's default or annotation hands
 * over, `f` in `Depends(f)`, read as the source writes it: a callee whose
 * last name the chain's methods table lists, and a name at the position
 * that method takes its callback.
 */
function writtenHandOver(node: PyNode, form: PyDependencyForm): string | null {
  const callee = node.type === "call" ? field(node, "function") : null;
  const name =
    callee?.type === "attribute" ? field(callee, "attribute") : callee;
  const at =
    name === null ? undefined : positionsHandedOver(form).get(name.text);
  const positional = children(field(node, "arguments")).filter(
    (argument) => argument.type !== "keyword_argument",
  );
  const handed = at === undefined ? undefined : positional[at];
  return handed?.type === "identifier" ? handed.text : null;
}

const positionsByForm = new WeakMap<
  PyDependencyForm,
  ReadonlyMap<string, number>
>();

/** Where each method of the form's chain takes its callback by position, read once per form. */
function positionsHandedOver(
  form: PyDependencyForm,
): ReadonlyMap<string, number> {
  const known = positionsByForm.get(form);
  if (known !== undefined) {
    return known;
  }
  const positions = callbackPositions(form.handedTo);
  positionsByForm.set(form, positions);
  return positions;
}

/** Each parameter's default, and its annotation when it has no default. */
function parameterDefaults(
  definitionNode: PyNode,
): { value: PyNode | null; annotation: PyNode | null }[] {
  return children(field(definitionNode, "parameters")).map((parameter) => ({
    value: field(parameter, "value"),
    annotation: field(parameter, "type"),
  }));
}

/** How far into an annotation the search for an injector call goes. `Annotated[T, Depends(f)]` needs three, and the rest is headroom. */
const MAX_ANNOTATION_DEPTH = 6;

/** The first node at or inside `node`, in source order, that `found` gives something for. */
function firstWithin<T>(
  node: PyNode | null,
  found: (node: PyNode) => T | null,
  depth = 0,
): T | null {
  if (node === null || depth > MAX_ANNOTATION_DEPTH) {
    return null;
  }
  const here = found(node);
  if (here !== null) {
    return here;
  }
  for (const child of children(node)) {
    const inside = firstWithin(child, found, depth + 1);
    if (inside !== null) {
      return inside;
    }
  }
  return null;
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
  return unitAround(
    target,
    declared.pattern,
    {
      continuations: continuationStatements(
        target.node,
        declared.form,
        options.facts,
      ),
      continuationName: null,
      form: declared.form,
      nameKind: "binding",
    },
    options,
  );
}

/**
 * The unit for the closure a project's decorator hands back. It hands
 * on where it calls the function the decorator was given, and every
 * `return` that does not make that call responds on its own.
 */
function closureUnit(
  target: ReachedFunction,
  closure: DecoratorClosure,
  options: WrapperIndexOptions,
): RawCodeStructure {
  return unitAround(
    target,
    closure.pattern,
    {
      continuations: callsThrough(
        target.node,
        closure.continuation,
        options.facts,
      ),
      continuationName: closure.continuation,
      form: null,
      nameKind: "label",
    },
    options,
  );
}

/** How a wrapper's body is read: where it hands on, and what its name is. */
interface WrapperReading {
  continuations: PyNode[];
  /** The name the continuation is called by, recorded where the wrapper hands on. */
  continuationName: string | null;
  /** The pack's form, which says when a `return` hands on. A closure has none, and its returns respond. */
  form: PyWrapperForm | null;
  nameKind: "binding" | "label";
}

function unitAround(
  target: ReachedFunction,
  pattern: PythonDiscoveryPattern,
  reading: WrapperReading,
  options: WrapperIndexOptions,
): RawCodeStructure {
  const { file, node, name, exportPath } = target;
  const body = field(node, "body");
  const range = rangeOf(node);
  const raised = raisedResponses(body, {
    calls: pattern.responseStatusCalls ?? [],
    module: file.module,
    facts: options.facts,
    constants: pattern.statusCodeConstants ?? {},
  });
  const continuations = reading.continuations;
  const terminals = bodyTerminals(body, raised, continuations);
  const effects = invocationSites(node, options.facts);
  const extra = recognizedBodyEffects(
    node,
    options.storageFor(file),
    options.facts,
  );
  const delegate = (at: PyNode, to: string | null = null): TerminalBranch => ({
    terminal: {
      kind: "delegate",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: to,
      emitEvent: null,
      location: rangeOf(at),
    },
    location: rangeOf(at),
  });
  const respond = (statement: PyNode): TerminalBranch =>
    returnBranch(statement, {
      pattern,
      responseShape: { reading: absentReading },
      declaredStatus: {
        reading: absentReading,
        ...(pattern.defaultStatusCode !== undefined
          ? { libraryDefault: pattern.defaultStatusCode }
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
    if (terminal.type === "continuation") {
      return delegate(terminal.statement, reading.continuationName);
    }
    if (
      reading.form !== null &&
      returnHandsOn(terminal.statement, reading.form)
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
    facts: options.facts,
  }).map((branch) => withBodyEffects(branch, extra));

  return {
    identity: {
      name,
      nameKind: reading.nameKind,
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
    const returned = statement.namedChild(0);
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
function continuationStatements(
  node: PyNode,
  form: PyWrapperForm,
  facts: Database | undefined,
): PyNode[] {
  if (
    form.type !== "decoratedWrapper" ||
    form.continuationParam === undefined
  ) {
    return [];
  }
  const params = children(field(node, "parameters"));
  const param = params[form.continuationParam];
  const continuation =
    param === undefined
      ? null
      : (field(param, "name")?.text ??
        (param.type === "identifier" ? param.text : null));
  return continuation === null ? [] : callsThrough(node, continuation, facts);
}

/**
 * Whether a middleware may send something other than what its
 * continuation returned. Its unit stops at the call, so a `return` after
 * it of anything else, such as a page sent in place of a 404, is unread.
 */
function mayReplaceResponse(
  node: PyNode,
  form: PyWrapperForm,
  facts: Database | undefined,
): boolean {
  const calls = continuationStatements(node, form, facts);
  const first = calls[0];
  if (first === undefined) {
    return false;
  }
  const handedBack = new Set(calls.flatMap(resultName));
  return returnStatements(field(node, "body")).some(
    (statement) =>
      spanOf(statement).start > spanOf(first).start &&
      !calls.some((call) => call.id === statement.id) &&
      !returnsName(statement, handedBack),
  );
}

/** The name a statement gives the continuation's result, `response` in `response = await call_next(request)`. */
function resultName(statement: PyNode): string[] {
  const written =
    statement.type === "expression_statement" ? statement.namedChild(0) : null;
  const left = written?.type === "assignment" ? field(written, "left") : null;
  return left?.type === "identifier" ? [left.text] : [];
}

function returnsName(statement: PyNode, names: ReadonlySet<string>): boolean {
  const value = statement.namedChild(0);
  return value?.type === "identifier" && names.has(value.text);
}

/** The statements in a function's body that call the name `callee`. */
function callsThrough(
  node: PyNode,
  callee: string,
  facts: Database | undefined,
): PyNode[] {
  const body = field(node, "body");
  if (body === null) {
    return [];
  }
  const found: PyNode[] = [];
  for (const call of bodyCalls(body, facts)) {
    const called = field(call, "function");
    const statement =
      called?.type === "identifier" && called.text === callee
        ? enclosingStatement(call, body)
        : null;
    if (statement !== null) {
      found.push(statement);
    }
  }
  return found;
}

/** Whether a statement is `return callee(...)` or `return await callee(...)`. */
function returnsCallTo(statement: PyNode, callee: string): boolean {
  if (statement.type !== "return_statement") {
    return false;
  }
  const value = statement.namedChild(0);
  const call = value?.type === "await" ? value.namedChild(0) : value;
  return call?.type === "call" && field(call, "function")?.text === callee;
}

/**
 * The function a decorator hands back when it is written in the
 * decorator's own body, `def wrapper(...)` followed by `return wrapper`.
 */
function closureReturnedBy(decorator: PyNode): PyNode | null {
  const statements = children(field(decorator, "body"));
  const returned = statements
    .find((statement) => statement.type === "return_statement")
    ?.namedChild(0);
  if (returned?.type !== "identifier") {
    return null;
  }
  for (const statement of statements) {
    const { definition } = stripDecorators(statement);
    if (
      definition.type === "function_definition" &&
      field(definition, "name")?.text === returned.text
    ) {
      return definition;
    }
  }
  return null;
}
