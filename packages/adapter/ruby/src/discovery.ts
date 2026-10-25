/**
 * Discovers the units a Ruby file defines: GraphQL fields declared through
 * a class DSL, controller actions, and client calls.
 *
 * A field's boundary binding and declared contract come from the
 * arguments of its own DSL call. A field written with one of the pack's
 * wiring keywords declares no type of its own, so its contract and the
 * method behind it are read from the class the keyword points at, one hop
 * away. DESIGN.md describes what a field's summary says about the method
 * behind it and where the reading stops.
 */

import {
  dispatchByType,
  graphqlResolverBinding,
  messageBusBinding,
  restBinding,
} from "@suss/behavioral-ir";
import { absentReading, unreadableReading } from "@suss/extractor";
import { nodeOfKey, spanOfKey } from "@suss/resolution";

import {
  ancestryOf,
  inheritedStatements,
  methodInAncestry,
  reachConstant,
} from "./ancestry.js";
import {
  booleanLiteralValue,
  field,
  instanceMethodsByName,
  instanceMethodVisibility,
  methodHasStatements,
  NodeMap,
  rangeOf,
  readCallArgs,
  runStatements,
  spanOf,
  symbolValue,
} from "./ast.js";
import {
  classesDeclaredInRun,
  classSettledOn,
  declaredName,
  enclosingClassKey,
} from "./baseClass.js";
import { askClientCallReads, clientCallUnits } from "./clientCalls.js";
import { createConstantFileCache } from "./constantPath.js";
import { envReadEffects } from "./envReads.js";
import { ExceptionReader } from "./exceptionClasses.js";
import { nodeId, readKey } from "./facts/values.js";
import {
  controllerFilterChain,
  filterCoversAction,
  filterOf,
  filterReference,
  filterUnit,
  unreadFilterReference,
} from "./filters.js";
import {
  contractShapeOf,
  declaredOutput,
  fieldIsNullable,
  nullKeywordOf,
  objectTypeFields,
  orNull,
  ownGraphqlName,
  ownTypeNode,
  resolvedName,
  resolverBranches,
  typeContext,
} from "./graphqlOutput.js";
import { jobEnqueueEffects, jobHandlersOf, type RbJobOptions } from "./jobs.js";
import {
  EVERY_ARGLESS_CALL,
  effectSitesIn,
  invocationSites,
  methodBody,
} from "./paths/effects.js";
import {
  askSourcesOfBodies,
  slotProvenance,
  withSlotSources,
} from "./provenance.js";
import { raisedStatusBranches } from "./raisedStatuses.js";
import { escapingRaises, raisedClassRef } from "./raises.js";
import { libraryUnit } from "./reach/closure.js";
import {
  hookReference,
  hooksRun,
  hookUnit,
  unsettledHookReading,
} from "./resolverHooks.js";
import {
  boundStatusArguments,
  helperResponse,
  responseBranches,
} from "./responseStatus.js";
import {
  constantRefCandidates,
  graphqlTypeNameFromQualified,
  walkDefinitions,
} from "./scope.js";
import { methodStorage, type RbStorageOptions } from "./storage.js";
import { streamWriteEffects } from "./streamWrites.js";
import { testCaseUnits, testPatternsIn } from "./testCases.js";
import { testClassPatternsIn, testClassUnits } from "./testClasses.js";
import { typeShapeFromNode } from "./typeShape.js";
import { stringValueOf } from "./values/evaluator.js";

import type {
  DispatchTable,
  Effect,
  GraphqlDeclaredContract,
  TypeShape,
  WrapperReference,
} from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  BodyContent,
  PlacedEffect,
  RawBranch,
  RawCodeStructure,
  RawEffect,
  RawParameter,
  RawProvenance,
  Reading,
} from "@suss/extractor";
import type {
  AncestorLookup,
  Ancestry,
  BodyReading,
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
import type { BlockConfigures, BodyBlocks, CallArgs, Range } from "./ast.js";
import type { ClientCallOptions } from "./clientCalls.js";
import type { ConstantFileCache } from "./constantPath.js";
import type { DynamicNames } from "./defineMethod.js";
import type { ExceptionClass } from "./exceptionClasses.js";
import type { ControllerFilter, FilterLink } from "./filters.js";
import type {
  DeclaredOutput,
  FileScope,
  TypeClass,
  TypeClassReader,
  WrittenType,
} from "./graphqlOutput.js";
import type {
  ControllerActions,
  ControllerRoute,
  GraphqlObjectFields,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
import type { RbNode } from "./parser.js";
import type { InheritedMethods } from "./paths/effects.js";
import type { HandlerClasses, RaisesRead } from "./raisedStatuses.js";
import type { HookDefinition } from "./resolverHooks.js";
import type { RespondingHelper } from "./responseStatus.js";
import type { ClassInfo } from "./scope.js";
import type { SharedGroupIndex } from "./testSharedGroups.js";

/**
 * What one run has read from the disk: parsed files by absolute path, so
 * a class that several fields refer to is only parsed once, and what its
 * constant lookups have found.
 */
export interface FileCache {
  get(absPath: string): Promise<RbNode | null>;
  readonly constantFiles: ConstantFileCache;
}

export function createFileCache(
  parse: (source: string, absPath: string) => Promise<RbNode>,
  readFile: (absPath: string) => string | null,
): FileCache {
  const trees = new Map<string, RbNode | null>();
  return {
    constantFiles: createConstantFileCache(),
    async get(absPath: string): Promise<RbNode | null> {
      const cached = trees.get(absPath);
      if (cached !== undefined) {
        return cached;
      }
      const source = readFile(absPath);
      const tree = source !== null ? await parse(source, absPath) : null;
      trees.set(absPath, tree);
      return tree;
    },
  };
}

/**
 * What reading a method body needs from the run's packs. Any options
 * object that has these fields, `DiscoveryOptions` among them, can be
 * passed straight through.
 */
export interface BodyReadOptions {
  /** The run's facts, which the value evaluator reads names through. Absent in a test that builds one file by hand. */
  readonly facts?: Database | undefined;
  /** The storage patterns that decide whether a call reads or writes the database. Absent when no pack declares any. */
  readonly storage?: RbStorageOptions | undefined;
  /** The job patterns that decide whether a call enqueues a background job. Absent when no pack declares any. */
  readonly jobs?: RbJobOptions | undefined;
  /** The methods the run's packs declare their libraries define. Calls to them are left off an effect list. */
  readonly inheritedMethods?: InheritedMethods | undefined;
  /** The calls whose block the run's packs declare runs as part of the surrounding body. */
  readonly bodyBlocks?: BodyBlocks | undefined;
  /** The methods each class defines under a name computed at run time, by class key. */
  readonly dynamicNames?: DynamicNames | undefined;
}

export interface DiscoveryOptions extends BodyReadOptions {
  packs: RubyPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
  /** Absolute path of the file being read, used for `ReachedBody.file`. Falls back to `filePath` for a source that is not on disk. */
  absoluteFile?: string;
  /** The `location.file` to record for another file, needed when a controller's filters come from an ancestor in another file. */
  displayPathOf?: (absolute: string) => string;
  cache: FileCache;
  /** Called once for each discovered unit whose body is a method, so the reach walk can start from it. */
  onReachSeed?: (raw: RawCodeStructure, seed: ReachSeed) => void;
  /** The shared groups the run's test files define, when a pack reads tests. */
  sharedGroups?: SharedGroupIndex | undefined;
}

/** The method behind a discovered unit, and where it is, so the reach walk can start there as it does at any `def`. */
export interface ReachSeed {
  readonly file: string;
  readonly node: RbNode;
  /** The class the method is written in, or null for one written outside any class. */
  readonly enclosingQualifiedName: string | null;
}

interface FieldReadContext {
  pattern: GraphqlObjectFields;
  cache: FileCache;
  lookup: AncestorLookup;
  bodyRead: BodyReadOptions;
  facts: Database | undefined;
  /** The facts and body options again, in the form an ancestry lookup takes. */
  read: BodyReading;
  /** The absolute path of the file being read, which the facts key its expressions on. */
  file: string;
  /** Reads the class behind a field's declared type. */
  types: TypeClassReader;
}

function fieldReadContext(
  pattern: GraphqlObjectFields,
  cache: FileCache,
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): FieldReadContext {
  const base = fieldLookupContext(pattern, cache, fileBlocks, options);
  return {
    ...base,
    types: {
      pattern,
      classAt: (written) => typeClassAt(written, base),
      displayPath: (file) => displayPathIn(options, file),
      blockConfigures: blockConfiguresCall(pattern),
    },
  };
}

function fieldLookupContext(
  pattern: GraphqlObjectFields,
  cache: FileCache,
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Omit<FieldReadContext, "types"> {
  const facts = options.facts;
  const parsedFile = (absPath: string) => cache.get(absPath);
  return {
    pattern,
    cache,
    bodyRead: options,
    facts,
    file: options.absoluteFile ?? options.filePath,
    read: {
      facts,
      bodyBlocks: options.bodyBlocks,
      dynamicNames: options.dynamicNames,
    },
    lookup: {
      root: pattern.root,
      autoloadRoots: pattern.autoloadRoots ?? [],
      pathConvention: pattern.pathConvention,
      acronyms: pattern.acronyms ?? [],
      ancestryRootClassNames: pattern.ancestryRootClassNames,
      constantFiles: cache.constantFiles,
      parsedFile,
      localDefinition: (name) => sameFileBlocks(name, fileBlocks),
      ...(facts === undefined
        ? {}
        : { definedInRun: classesDeclaredInRun(facts, parsedFile) }),
    },
  };
}

/** The blocks the current file defines under `name`, or null so the walk falls back to the path convention. */
function sameFileBlocks(
  name: string,
  fileBlocks: readonly ReachedBody[],
): ReachedBody[] | null {
  const matches = fileBlocks.filter(
    (block) => block.info.qualifiedName === name,
  );
  return matches.length === 0 ? null : matches;
}

/** The class a declared type's constant refers to, found the way a wiring keyword's class is. */
async function typeClassAt(
  written: WrittenType,
  ctx: Omit<FieldReadContext, "types">,
): Promise<TypeClass | null> {
  const candidates = constantRefCandidates(written.node, written.scope.nesting);
  const reached =
    (await classInRun(written.node, written.file, ctx)) ??
    (candidates.length === 0
      ? null
      : await reachConstant(candidates, ctx.lookup));
  if (reached === null) {
    return null;
  }
  return {
    name: reached.name,
    blocks: reached.blocks,
    ancestry: await ancestryOf(reached.name, reached.blocks, ctx.lookup),
  };
}

export async function discoverUnits(
  root: RbNode,
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  const classes: ClassInfo[] = [];
  // Modules are included because a graphql-ruby interface is a module
  // that mixes in the interface base and declares fields the same way.
  walkDefinitions(root, (info) => classes.push(info));
  const knownClasses = new Set(classes.map((info) => info.qualifiedName));

  const fileBlocks: ReachedBody[] = classes.map((info) => ({
    info,
    knownClasses,
    file: options.absoluteFile ?? options.filePath,
  }));

  const units: RawCodeStructure[] = [];
  const clientOptions: ClientCallOptions = {
    filePath: options.filePath,
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  };
  askClientCallReads(
    root,
    options.packs.flatMap((pack) => pack.clients ?? []),
    clientOptions,
  );
  for (const pack of options.packs) {
    for (const pattern of pack.clients ?? []) {
      units.push(...clientCallUnits(root, pack, pattern, clientOptions));
    }
  }

  for (const info of classes) {
    // A class reopened in the same file is still one class, so a method in
    // a later block can override a field declared in an earlier one.
    const ownBlocks = fileBlocks.filter(
      (block) => block.info.qualifiedName === info.qualifiedName,
    );
    for (const pack of options.packs) {
      for (const pattern of pack.discovery) {
        units.push(
          ...(await unitsFor(
            pattern,
            pack,
            info,
            ownBlocks,
            fileBlocks,
            options,
          )),
        );
      }
    }
    units.push(...(await jobUnits(info, root, options)));
  }
  const absoluteFile = options.absoluteFile ?? options.filePath;
  units.push(
    ...testCaseUnits(root, testPatternsIn(options.packs), {
      filePath: options.filePath,
      absoluteFile,
      displayPathOf: options.displayPathOf ?? ((file) => file),
      facts: options.facts,
      inheritedMethods: options.inheritedMethods,
      shared: options.sharedGroups,
      onSeed: (raw, block, file) =>
        options.onReachSeed?.(raw, {
          file,
          node: block,
          enclosingQualifiedName: null,
        }),
    }),
    ...testClassUnits(root, testClassPatternsIn(options.packs), {
      filePath: options.filePath,
      absoluteFile,
      displayPathOf: options.displayPathOf ?? ((file) => file),
      facts: options.facts,
      inheritedMethods: options.inheritedMethods,
      onSeed: () => undefined,
      onClassSeed: (raw, node, qualifiedName) =>
        options.onReachSeed?.(raw, {
          file: absoluteFile,
          node,
          enclosingQualifiedName: qualifiedName,
        }),
    }),
  );
  return units;
}

/**
 * A consumer unit for each method a worker runs in this class block,
 * with the walk started from each. An inherited `perform` is read where
 * the base class writes it.
 */
async function jobUnits(
  info: ClassInfo,
  root: RbNode,
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  if (options.jobs === undefined) {
    return [];
  }
  const file = options.absoluteFile ?? options.filePath;
  const units: RawCodeStructure[] = [];
  for (const handler of jobHandlersOf(
    info,
    file,
    options.jobs,
    options.bodyBlocks,
  )) {
    const at = spanOfKey(handler.functionKey);
    const tree = at?.file === file ? root : await treeAt(at?.file, options);
    const node =
      at === null || tree === null
        ? null
        : nodeOfKey(new Map([[at.file, tree]]), handler.functionKey);
    if (at === null || node === null) {
      continue;
    }
    const raw = libraryUnit(
      {
        file: at.file,
        node,
        name: handler.name,
        exportPath: handler.exportPath,
      },
      { ...options, displayPathOf: (one) => displayPathIn(options, one) },
      messageBusBinding({
        recognition: handler.declaration.recognition,
        messageBus: handler.declaration.pattern.messageBus,
        channel: handler.channel,
      }),
    );
    const unit: RawCodeStructure = {
      ...raw,
      identity: { ...raw.identity, kind: "consumer" },
    };
    // An inherited `perform` is walked as the base class it is written
    // in, the same as the base job's own unit, so the two agree.
    options.onReachSeed?.(unit, {
      file: at.file,
      node,
      enclosingQualifiedName:
        at.file === file && isWithin(node, info.node)
          ? info.qualifiedName
          : writtenIn(node, at.file, options),
    });
    units.push(unit);
  }
  return units;
}

function isWithin(node: RbNode, outer: RbNode): boolean {
  return node.startIndex >= outer.startIndex && node.endIndex <= outer.endIndex;
}

/** The class a method is written in, by the name it is declared under, or null outside one. */
function writtenIn(
  method: RbNode,
  file: string,
  options: DiscoveryOptions,
): string | null {
  const classKey = enclosingClassKey(method, file);
  if (classKey === null || options.facts === undefined) {
    return null;
  }
  return declaredName(options.facts, classKey) ?? null;
}

async function treeAt(
  file: string | undefined,
  options: DiscoveryOptions,
): Promise<RbNode | null> {
  return file === undefined ? null : options.cache.get(file);
}

/**
 * Whether a class or module inherits from, or mixes in, one of the pack's
 * base classes, however many project bases are in between (#247). A base
 * the walk could not open stays in the ancestry under its written name,
 * so it still matches.
 */
function reachesConfiguredBase(
  ancestry: Ancestry,
  self: string,
  baseClassNames: readonly string[],
): boolean {
  return ancestry.some(
    (entry) => entry.name !== self && baseClassNames.includes(entry.name),
  );
}

function unitsFor(
  pattern: RubyDiscoveryPattern,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  const table: DispatchTable<
    RubyDiscoveryPattern,
    Promise<RawCodeStructure[]>
  > = {
    graphqlObjectFields: (p) =>
      graphqlObjectFieldUnits(p, pack, info, ownBlocks, fileBlocks, options),
    controllerActions: (p) =>
      controllerActionUnits(p, pack, info, ownBlocks, fileBlocks, options),
  };
  return dispatchByType(table, pattern);
}

async function graphqlObjectFieldUnits(
  pattern: GraphqlObjectFields,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  if (
    info.bodyNode === null ||
    pattern.baseClassNames.includes(info.qualifiedName)
  ) {
    return [];
  }
  const ctx = fieldReadContext(pattern, options.cache, fileBlocks, options);
  const ancestry = await ancestryOf(info.qualifiedName, ownBlocks, ctx.lookup);
  if (
    !reachesConfiguredBase(ancestry, info.qualifiedName, pattern.baseClassNames)
  ) {
    return [];
  }
  const typeName =
    ownGraphqlName(ownBlocks, pattern, ctx.types.blockConfigures) ??
    graphqlTypeNameFromQualified(
      info.qualifiedName,
      pattern.typeNameConvention,
    );
  const knownClasses = ownBlocks[0]?.knownClasses ?? new Set<string>();
  const scope: FileScope = { nesting: info.bodyNesting, knownClasses };

  // The library stores fields by name, so a field declared again later in
  // the body replaces the earlier one. Keying on the field name matches that.
  const declsByName = new Map<string, FieldDeclaration>();
  for (const stmt of runStatements(
    info.bodyNode,
    blockConfiguresCall(pattern),
  )) {
    const decl = await readFieldCall(stmt, scope, ctx, ancestry);
    if (decl !== null) {
      declsByName.set(decl.fieldName, decl);
    }
  }
  const decls = [...declsByName.values()];
  const fields = decls.map((decl) => {
    const raw = buildFieldUnit(pack, pattern, typeName, decl, options);
    if (decl.body.reachSeed !== undefined) {
      options.onReachSeed?.(raw, decl.body.reachSeed);
    }
    return raw;
  });
  return [...fields, ...hookUnitsOf(decls, pattern, options)];
}

/** One unit for each hook the fields run, however many fields share it, with the walk started from each. */
function hookUnitsOf(
  decls: readonly FieldDeclaration[],
  pattern: GraphqlObjectFields,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const hooks = pattern.resolverHooks;
  if (hooks === undefined) {
    return [];
  }
  const units = new Map<string, RawCodeStructure>();
  for (const hook of decls.flatMap((decl) => decl.hooks)) {
    const key = nodeId(hook.block.file, hook.method);
    if (units.has(key)) {
      continue;
    }
    const raw = hookUnit(hook, {
      hooks,
      body: bodyOfMethod(hook.method, hook.block.file, options),
      displayPath: displayPathIn(options, hook.block.file),
      facts: options.facts,
    });
    units.set(key, raw);
    options.onReachSeed?.(raw, {
      file: hook.block.file,
      node: hook.method,
      enclosingQualifiedName: hook.block.info.qualifiedName,
    });
  }
  return [...units.values()];
}

/** The `location.file` a unit written in `file` gets. */
function displayPathIn(options: DiscoveryOptions, file: string): string {
  if (file === (options.absoluteFile ?? options.filePath)) {
    return options.filePath;
  }
  return options.displayPathOf?.(file) ?? file;
}

/**
 * Every public instance method a controller defines directly is an
 * action. Rails dispatches only to public methods, so a private or
 * protected one is not discovered here, though the reach walk still
 * gives it a summary once something calls it. Each action becomes one
 * unit per route `routesFor` finds, or one unbound unit when it finds
 * none, and the reach walk starts from each.
 */
async function controllerActionUnits(
  pattern: ControllerActions,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  if (
    info.bodyNode === null ||
    pattern.baseClassNames.includes(info.qualifiedName)
  ) {
    return [];
  }
  const lookup: AncestorLookup = {
    root: pattern.root,
    autoloadRoots: pattern.autoloadRoots ?? [],
    pathConvention: pattern.pathConvention,
    acronyms: pattern.acronyms ?? [],
    ancestryRootClassNames: pattern.ancestryRootClassNames,
    constantFiles: options.cache.constantFiles,
    parsedFile: (absPath) => options.cache.get(absPath),
    localDefinition: (name) => sameFileBlocks(name, fileBlocks),
  };
  const ancestry = await ancestryOf(info.qualifiedName, ownBlocks, lookup);
  // A class that extends one of the library's root classes directly, with
  // no project base in between, is a controller too.
  if (
    !reachesConfiguredBase(ancestry, info.qualifiedName, [
      ...pattern.baseClassNames,
      ...pattern.ancestryRootClassNames,
    ])
  ) {
    return [];
  }

  const chain = controllerFilterChain(pattern, ancestry, {
    facts: options.facts,
    bodyBlocks: options.bodyBlocks,
    dynamicNames: options.dynamicNames,
  });
  const filters = chain.flatMap((link) => ("read" in link ? [link.read] : []));
  const units: RawCodeStructure[] = [];
  const actions = controllerActions(
    pattern,
    info,
    ownBlocks,
    ancestry,
    options,
  );
  askSourcesOfBodies(
    [
      ...filters.map((filter) => ({
        file: filter.file,
        method: filter.method,
      })),
      ...actions.map(([, method, block]) => ({ file: block.file, method })),
    ],
    options.facts,
    options.storage,
  );

  const respondingHelper = respondingHelpersOf(ancestry, pattern, options);
  const exceptions = new ExceptionReader(
    lookup,
    pattern.libraryExceptions ?? {},
  );
  const caught = await handlerClasses(filters, exceptions);
  const handlersAround = (actionName: string): HandlerClasses[] =>
    filters
      .filter((filter) => filterCoversAction(filter, actionName))
      .flatMap((filter) => {
        const classes = caught.get(filter);
        return classes === undefined ? [] : [classes];
      });
  for (const filter of filters) {
    const displayPath = options.displayPathOf?.(filter.file) ?? filter.file;
    const body = bodyOfMethod(filter.method, filter.file, options);
    const handler = filter.filter.onThrow === true;
    const raw = filterUnit(filter, pattern, displayPath, body, {
      facts: options.facts,
      respondingHelper,
      ...(handler
        ? {}
        : {
            raises: {
              classes: await raisedClasses(
                filter.method,
                filter.nesting,
                exceptions,
                options.facts,
              ),
              handlers: "eachRoute",
            },
            raised: raisedStatusBranches(
              pattern,
              options.storage?.patterns ?? [],
              everyEffect(body.extraEffects),
              "eachRoute",
              rangeOf(filter.method),
            ),
          }),
    });
    units.push(raw);
    options.onReachSeed?.(raw, {
      file: filter.file,
      node: filter.method,
      enclosingQualifiedName: filter.enclosingQualifiedName,
    });
  }

  const displayPath = (file: string): string =>
    options.displayPathOf?.(file) ?? file;
  const referenceTo = (link: FilterLink): WrapperReference =>
    "read" in link
      ? filterReference(
          link.read,
          displayPath(link.read.file),
          caught.get(link.read),
        )
      : unreadFilterReference(link.unread, displayPath(link.unread.declaredIn));

  const emitAction = async (
    actionName: string,
    method: RbNode,
    block: ReachedBody,
    routes: readonly ControllerRoute[],
  ) => {
    const around = chain
      .filter((link) => filterCoversAction(filterOf(link), actionName))
      .map((link) => referenceTo(link));
    const raises: RaisesRead = {
      classes: await raisedClasses(
        method,
        block.info.bodyNesting,
        exceptions,
        options.facts,
      ),
      handlers: handlersAround(actionName),
    };
    // An action routed twice, such as `update` under both PATCH and PUT,
    // serves each route, so each gets a unit of its own.
    for (const route of routes.length === 0 ? [null] : routes) {
      const raw = buildControllerActionUnit(
        pack,
        pattern,
        info.qualifiedName,
        actionName,
        route,
        method,
        { display: displayPathIn(options, block.file), absolute: block.file },
        options,
        around,
        respondingHelper,
        raises,
      );
      units.push(raw);
      options.onReachSeed?.(raw, {
        file: block.file,
        node: method,
        enclosingQualifiedName: block.info.qualifiedName,
      });
    }
  };

  for (const [actionName, method, block] of actions) {
    const routes = pattern.routesFor(info.qualifiedName, actionName);
    await emitAction(actionName, method, block, routes);
  }
  return units;
}

/** The exception classes each handler is registered for. */
async function handlerClasses(
  filters: readonly ControllerFilter[],
  exceptions: ExceptionReader,
): Promise<Map<ControllerFilter, HandlerClasses>> {
  const caught = new Map<ControllerFilter, HandlerClasses>();
  for (const filter of filters) {
    if (filter.filter.onThrow !== true) {
      continue;
    }

    const classes: ExceptionClass[] = [];
    for (const ref of filter.rescues.refs) {
      classes.push(await exceptions.read(ref));
    }
    caught.set(filter, { classes, someUnread: filter.rescues.someUnread });
  }
  return caught;
}

/** The class each raise in a method raises, or null for one the source computes. */
async function raisedClasses(
  method: RbNode,
  nesting: readonly string[],
  exceptions: ExceptionReader,
  facts: Database | undefined,
): Promise<NodeMap<ExceptionClass | null>> {
  const classes = new NodeMap<ExceptionClass | null>();
  for (const call of escapingRaises(method)) {
    const ref = raisedClassRef(call, nesting, facts);
    classes.set(call, ref === null ? null : await exceptions.read(ref));
  }
  return classes;
}

/**
 * The actions a controller serves: its own public methods, then each
 * routed action an ancestor defines and the controller does not. Rails
 * dispatches a routed action to whichever ancestor defines it, so a
 * subclass with a route to `show` and no `show` of its own runs the base's.
 */
function controllerActions(
  pattern: ControllerActions,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  ancestry: Awaited<ReturnType<typeof ancestryOf>>,
  options: DiscoveryOptions,
): Array<[string, RbNode, ReachedBody]> {
  const actions = publicInstanceMethods(ownBlocks, options.bodyBlocks);
  const seen = new Set(actions.map(([actionName]) => actionName));
  for (const entry of ancestry) {
    if (entry.type !== "bodies" || entry.name === info.qualifiedName) {
      continue;
    }
    for (const action of publicInstanceMethods(
      entry.blocks,
      options.bodyBlocks,
    )) {
      const [actionName] = action;
      if (seen.has(actionName)) {
        continue;
      }
      seen.add(actionName);
      if (pattern.routesFor(info.qualifiedName, actionName).length > 0) {
        actions.push(action);
      }
    }
  }
  return actions;
}

/** Every public instance method the blocks define, with the block it is written in, in source order. */
function publicInstanceMethods(
  blocks: readonly ReachedBody[],
  bodyBlocks: BodyBlocks | undefined,
): Array<[string, RbNode, ReachedBody]> {
  const found: Array<[string, RbNode, ReachedBody]> = [];
  for (const block of blocks) {
    if (block.info.bodyNode === null) {
      continue;
    }
    const visibility = instanceMethodVisibility(block.info.bodyNode);
    for (const [name, method] of instanceMethodsByName(
      block.info.bodyNode,
      bodyBlocks,
    )) {
      if ((visibility.get(name) ?? "public") === "public") {
        found.push([name, method, block]);
      }
    }
  }
  return found;
}

/**
 * What each project method the controller can call sends, when every
 * path through it responds, read once per name and status the call
 * passes. A method this run cannot find in the ancestry, or one an
 * unread ancestor might replace, sends nothing it can claim.
 */
function respondingHelpersOf(
  ancestry: Ancestry,
  pattern: ControllerActions,
  options: DiscoveryOptions,
): RespondingHelper {
  const methods = new Map<string, RbNode | null>();
  const known = new Map<string, Reading<number> | null>();
  const declared = new Set(
    (pattern.responseStatusCalls ?? []).map((call) => call.name),
  );
  const methodNamed = (name: string): RbNode | null => {
    if (!methods.has(name)) {
      const found = methodInAncestry(ancestry, name, {
        facts: options.facts,
        bodyBlocks: options.bodyBlocks,
        dynamicNames: options.dynamicNames,
      });
      methods.set(name, found.type === "found" ? found.method : null);
    }
    return methods.get(name) ?? null;
  };
  return (name, call) => {
    const method = declared.has(name) ? null : methodNamed(name);
    if (method === null) {
      return null;
    }
    const bound = boundStatusArguments(method, call, pattern, options.facts);
    const key = `${name}(${[...bound].join(",")})`;
    if (!known.has(key)) {
      known.set(key, helperResponse(method, pattern, options.facts, bound));
    }
    return known.get(key) ?? null;
  };
}

/** Rails, like a framework modelled on it, adds no format to a path that ends in a slash. */
function servesFormat(
  pattern: ControllerActions,
  route: ControllerRoute,
): boolean {
  return (
    pattern.optionalFormat === true &&
    route.formatless !== true &&
    !route.path.endsWith("/")
  );
}

function buildControllerActionUnit(
  pack: RubyPack,
  pattern: ControllerActions,
  controllerQualifiedName: string,
  actionName: string,
  route: ControllerRoute | null,
  method: RbNode,
  file: { display: string; absolute: string },
  bodyRead: BodyReadOptions,
  wrappers: readonly WrapperReference[],
  respondingHelper: RespondingHelper,
  raises: RaisesRead,
): RawCodeStructure {
  const range = rangeOf(method);
  const body = bodyOfMethod(method, file.absolute, bodyRead);
  const perResponse = responseBranches(
    method,
    pattern,
    body.effects ?? [],
    body.extraEffects,
    {
      facts: bodyRead.facts,
      respondingHelper,
      raises,
    },
  );
  return {
    identity: {
      name: actionName,
      nameKind: "binding",
      kind: "handler",
      file: file.display,
      range,
      span: spanOf(method),
      exportName: actionName,
      exportPath: [controllerQualifiedName, actionName],
    },
    boundaryBinding:
      route === null
        ? null
        : restBinding({
            transport: pack.protocol,
            method: route.method,
            path: route.path,
            recognition: pack.name,
            optionalFormat: servesFormat(pattern, route),
          }),
    parameters: [],
    branches: withSlotSources(
      perResponse ?? [
        {
          conditions: [],
          terminal: {
            kind: "response",
            statusCode: null,
            body: null,
            exceptionType: null,
            message: null,
            component: null,
            renderTree: null,
            delegateTarget: null,
            emitEvent: null,
            location: range,
          },
          statusCodeReading: {
            reading: absentReading,
            libraryDefault: pattern.defaultStatusCode,
          },
          effects: everyEffect(body.effects),
          ...(body.extraEffects === undefined
            ? {}
            : { extraEffects: everyEffect(body.extraEffects) }),
          location: range,
          isDefault: true,
        },
      ],
      body.provenance,
    ).concat(
      raisedStatusBranches(
        pattern,
        bodyRead.storage?.patterns ?? [],
        everyEffect(body.extraEffects),
        raises.handlers,
        range,
      ),
    ),
    bodyContent: body.bodyContent ?? "absent",
    dependencyCalls: [],
    declaredContract: null,
    ...(wrappers.length > 0 ? { wrappers: [...wrappers] } : {}),
    ...(pack.requestSpelling === undefined
      ? {}
      : { requestSpelling: pack.requestSpelling }),
  };
}

/**
 * A unit with no boundary and no calls, recording the routing
 * declarations this pattern could not read. Build it once per pattern,
 * after every file has been discovered, and not once per controller.
 */
export function routingGapUnit(
  pattern: ControllerActions,
  gaps: readonly string[],
): RawCodeStructure {
  const range = { start: 1, end: 1 };
  return {
    identity: {
      name: "routes",
      kind: "module-init",
      file: pattern.routesFile,
      range,
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: null,
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: {
          kind: "void",
          statusCode: null,
          body: null,
          exceptionType: null,
          message: null,
          component: null,
          renderTree: null,
          delegateTarget: null,
          emitEvent: null,
          location: range,
        },
        effects: [],
        location: range,
        isDefault: true,
      },
    ],
    readings: gaps.map((gap) => unreadableReading(gap, range)),
    dependencyCalls: [],
    declaredContract: null,
  };
}

/**
 * A block on one of the pack's DSL calls configures that call.
 * `field :x, String do argument :q, String end` declares an argument on
 * the field, so reading the block as part of the class body would put the
 * argument on the class.
 */
function blockConfiguresCall(pattern: GraphqlObjectFields): BlockConfigures {
  const names = new Set([
    pattern.fieldCallName,
    pattern.typeCallName,
    pattern.argumentCallName,
  ]);
  return (call) => {
    const method = field(call, "method")?.text;
    return (
      field(call, "receiver") === null &&
      method !== undefined &&
      names.has(method)
    );
  };
}

interface ArgDeclaration {
  name: string;
  type: TypeShape;
  required: boolean;
  typeText: string | null;
}

interface FieldContract {
  returnType: TypeShape;
  /** The arguments the schema exposes on the wire. */
  args: ArgDeclaration[];
  /**
   * When argument wrapping applies, the declared arguments as written.
   * The library unwraps the input object before calling the resolver
   * method, so the method's parameters match these instead of `args`.
   */
  methodArgs?: ArgDeclaration[];
  /** What the field resolves to, with null where the schema allows it, or null when the declared type was not read. */
  output: DeclaredOutput | null;
}

interface FieldDeclaration {
  fieldName: string;
  /** False when the name is computed at run time, so no wire name can be matched against it. */
  namedOnTheWire: boolean;
  node: RbNode;
  contract: FieldContract | null;
  body: BodyReport;
  /** The hooks the library runs on the wired class before its resolver method, in order. */
  hooks: readonly HookDefinition[];
}

/** One branch for each path through the method behind a field, or none when no method was read. */
function branchesFor(
  decl: FieldDeclaration,
  pattern: GraphqlObjectFields,
  facts: Database | undefined,
): RawBranch[] {
  const method = decl.body.reachSeed?.node;
  if (method === undefined) {
    return [];
  }
  return resolverBranches({
    method,
    body: decl.body,
    declared: decl.contract?.output ?? null,
    facts,
    errorClassNames: pattern.returnedErrorClassNames ?? [],
  });
}

/**
 * Every effect a body has, wherever it was written. A branch that ends
 * where the method ends gets all of them, since every one can run first.
 */
function everyEffect<E>(placed: readonly PlacedEffect<E>[] | undefined): E[] {
  return (placed ?? []).map((one) => one.effect);
}

/** A field's contract and the method behind it, read together because a wiring keyword decides both. */
interface FieldReading {
  contract: FieldContract | null;
  body: BodyReport;
  hooks?: readonly HookDefinition[];
}

export interface BodyReport {
  /**
   * Left unset when no value would be accurate. The extractor writes its
   * own sentence from this field, and `readings` has a more accurate one.
   */
  bodyContent?: BodyContent;
  readings: Reading<unknown>[];
  /** The calls the method makes, each with where it is written and the conditions it runs under. */
  effects?: PlacedEffect<RawEffect>[];
  /** Effects a recognizer built in IR form, such as database work, each with where it is written. */
  extraEffects?: PlacedEffect<Effect>[];
  /** Where the values in the slots of `extraEffects` came from. */
  provenance?: RawProvenance[];
  /** Set when this body came from a method, so the reach walk can follow the calls it makes. */
  reachSeed?: ReachSeed;
}

/** `file` is the absolute path the method was read from, which the storage recognizer keys constant bindings on. */
export function bodyOfMethod(
  method: RbNode,
  file: string,
  bodyRead: BodyReadOptions = {},
): BodyReport {
  // Every call with no arguments goes on the list, and the reach walk
  // removes the ones that turn out to be property reads.
  const effects = invocationSites(
    method,
    bodyRead.inheritedMethods,
    EVERY_ARGLESS_CALL,
    bodyRead.facts,
  );
  const storage = bodyRead.storage;
  const facts = bodyRead.facts;
  const database =
    storage === undefined
      ? { effects: [], slots: [] }
      : methodStorage(method, file, storage);
  const found = [
    ...envReadEffects(
      method,
      facts === undefined ? undefined : { db: facts, file },
    ),
    ...database.effects,
    ...jobEnqueueEffects(method, file, bodyRead.jobs),
    ...streamWriteEffects(method),
  ];
  const siteOf = effectSitesIn(
    methodBody(method),
    found.map((one) => one.at),
  );
  const extra = found.map(({ effect, at }) => ({ effect, site: siteOf(at) }));
  const provenance =
    database.slots.length === 0 || storage === undefined
      ? []
      : slotProvenance(database.slots, { facts: storage.facts, unit: method });
  return {
    bodyContent: methodHasStatements(method) ? "statements" : "empty",
    readings: [],
    ...(effects.length > 0 ? { effects } : {}),
    ...(extra.length > 0 ? { extraEffects: extra } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
  };
}

/** A field with no method behind it: the library reads the attribute off the object the field was resolved against, so there is no body to read. */
const NO_METHOD_BEHIND_IT: BodyReport = {
  bodyContent: "absent",
  readings: [],
};

function methodNotSettled(reason: string, range: Range): BodyReport {
  return { readings: [unreadableReading(reason, range)] };
}

/**
 * The body report for an ancestry lookup. `nothingThere` is the report to
 * give when the lookup read the whole ancestry and found no method.
 */
function bodyFromLookup(
  found: MethodLookup,
  range: Range,
  subject: string,
  nothingThere: BodyReport,
  bodyRead: BodyReadOptions,
): BodyReport {
  const table: DispatchTable<MethodLookup, BodyReport> = {
    found: (lookup) => ({
      ...bodyOfMethod(lookup.method, lookup.block.file, bodyRead),
      reachSeed: {
        file: lookup.block.file,
        node: lookup.method,
        enclosingQualifiedName: lookup.block.info.qualifiedName,
      },
    }),
    unsettled: (lookup) =>
      methodNotSettled(
        `${subject} could be answered by a method ${lookup.reason}, so whether one exists was not settled here`,
        range,
      ),
    none: () => nothingThere,
  };
  return dispatchByType(table, found);
}

/**
 * A field whose type cannot be read is still discovered, with no declared
 * contract, since the symbol alone shows the field exists. A field whose
 * name cannot be read is discovered too, under the expression it was
 * written as and with no binding. Dropping it would make the declaration
 * look as if it had never been written.
 */
async function readFieldCall(
  stmt: RbNode,
  scope: FileScope,
  ctx: FieldReadContext,
  ancestry: Ancestry,
): Promise<FieldDeclaration | null> {
  if (stmt.type !== "call" || field(stmt, "receiver") !== null) {
    return null;
  }
  if (field(stmt, "method")?.text !== ctx.pattern.fieldCallName) {
    return null;
  }
  const callArgs = readCallArgs(field(stmt, "arguments"));
  const nameArg = callArgs.positional[0];
  if (nameArg === undefined) {
    return null;
  }
  const symbol = symbolValue(nameArg);
  if (symbol === null) {
    return computedNameDeclaration(stmt, nameArg);
  }
  const read = await readFieldShape(
    symbol,
    callArgs,
    scope,
    ctx,
    ancestry,
    rangeOf(stmt),
  );
  return {
    fieldName: resolvedName(symbol, callArgs, ctx.pattern),
    namedOnTheWire: true,
    node: stmt,
    contract: read.contract,
    body: read.body,
    hooks: read.hooks ?? [],
  };
}

/** A field whose name is computed when the class body runs, so the file does not contain the name the schema uses. */
function computedNameDeclaration(
  stmt: RbNode,
  nameArg: RbNode,
): FieldDeclaration {
  const range = rangeOf(stmt);
  return {
    fieldName: nameArg.text,
    namedOnTheWire: false,
    node: stmt,
    contract: null,
    hooks: [],
    body: {
      readings: [
        unreadableReading(
          `This field is named by ${nameArg.text}, which is worked out when the class body runs, so the name the schema exposes it under was not read here`,
          range,
        ),
      ],
    },
  };
}

/** When a call uses more than one of the pattern's wiring keywords, the first one listed in the pattern wins. */
function wiringReference(
  callArgs: CallArgs,
  wiringKeywords: readonly string[],
): RbNode | null {
  for (const keyword of wiringKeywords) {
    const ref = callArgs.keyword[keyword];
    if (ref !== undefined) {
      return ref;
    }
  }
  return null;
}

/** The contract is null when no shape could be read for the field, whether it wrote no type or one this reader does not follow. */
async function readFieldShape(
  symbol: string,
  callArgs: CallArgs,
  scope: FileScope,
  ctx: FieldReadContext,
  ancestry: Ancestry,
  range: Range,
): Promise<FieldReading> {
  const typeNode = ownTypeNode(callArgs, ctx.pattern);
  // The library lets a field's own type and null keyword win over the
  // ones its wired class declares.
  const own: DeclaredType = {
    written:
      typeNode === undefined ? null : { node: typeNode, scope, file: ctx.file },
    nullable: nullKeywordOf(callArgs, ctx.pattern),
  };
  const oneHopRef = wiringReference(callArgs, ctx.pattern.wiringKeywords);
  if (oneHopRef !== null) {
    return readWiredClass(oneHopRef, scope, own, ctx);
  }

  return {
    contract: await fieldContract(own, null, ctx),
    body: methodBehindField(symbol, callArgs, ctx, ancestry, range),
  };
}

/** A type expression a field or its wired class declares, and what the same call says about null. */
interface DeclaredType {
  written: WrittenType | null;
  nullable: boolean | null;
}

/**
 * The contract for a field, from its own declared type or else its
 * wired class's. A class with no type call declares its payload with
 * field calls. Null when neither declares a shape.
 */
async function fieldContract(
  own: DeclaredType,
  wired: ClassDeclaration | null,
  ctx: FieldReadContext,
): Promise<FieldContract | null> {
  const pattern = ctx.pattern;
  const nullable = fieldIsNullable(
    own.nullable,
    wired?.type.nullable ?? null,
    pattern,
  );
  const args = { args: wired?.args ?? [], ...wiredMethodArgs(wired) };
  const written = own.written ?? wired?.type.written ?? null;
  const literal =
    written === null
      ? null
      : typeShapeFromNode(written.node, typeContext(written.scope, pattern));
  const output =
    written === null || literal === null
      ? null
      : await declaredOutput(written, nullable, ctx.types);
  if (literal !== null) {
    return {
      returnType: output === null ? literal : contractShapeOf(output.shape),
      ...args,
      output,
    };
  }

  const payload = wired?.payload ?? {};
  if (wired === null || Object.keys(payload).length === 0) {
    return null;
  }
  return {
    returnType: { type: "record", properties: payload },
    ...args,
    output: {
      shape: orNull(
        {
          type: "record",
          properties: objectTypeFields(wired.ancestry, ctx.types),
        },
        nullable,
      ),
      definitions: {},
    },
  };
}

function wiredMethodArgs(
  wired: ClassDeclaration | null,
): Pick<FieldContract, "methodArgs"> {
  return wired?.methodArgs === undefined
    ? {}
    : { methodArgs: wired.methodArgs };
}

/**
 * The type's own method behind a field: the one its resolver-method
 * keyword gives, or the one with the field's name. The library calls the
 * keyword's method even when none exists, so that is not a missing body.
 */
function methodBehindField(
  symbol: string,
  callArgs: CallArgs,
  ctx: FieldReadContext,
  ancestry: Ancestry,
  range: Range,
): BodyReport {
  const keyword = ctx.pattern.resolverMethodKeyword;
  const written = keyword === undefined ? undefined : callArgs.keyword[keyword];
  if (written === undefined) {
    return bodyFromLookup(
      methodInAncestry(ancestry, symbol, ctx.read),
      range,
      "This field",
      NO_METHOD_BEHIND_IT,
      ctx.bodyRead,
    );
  }

  const name = stringValueOf(written, ctx.facts);
  if (name === null) {
    return methodNotSettled(
      `This field is resolved by the method ${written.text}, which is worked out at run time, so nothing about what it does was read here`,
      range,
    );
  }
  return bodyFromLookup(
    methodInAncestry(ancestry, name, ctx.read),
    range,
    "This field",
    methodNotSettled(
      `This field is resolved by ${name}, which nothing in its type's ancestry defines, so nothing about what it does was read here`,
      range,
    ),
    ctx.bodyRead,
  );
}

/** A wiring keyword points at the class that resolves the field, so that class's ancestry gives the declared shape, the resolver method and the hooks run before it. */
async function readWiredClass(
  ref: RbNode,
  scope: FileScope,
  own: DeclaredType,
  ctx: FieldReadContext,
): Promise<FieldReading> {
  const range = rangeOf(ref);

  const candidates = constantRefCandidates(ref, scope.nesting);
  const reached =
    (await classInRun(ref, ctx.file, ctx)) ??
    (candidates.length === 0
      ? null
      : await reachConstant(candidates, ctx.lookup));
  if (reached === null) {
    return {
      contract: await fieldContract(own, null, ctx),
      body: methodNotSettled(
        candidates.length === 0
          ? `This field is wired to ${ref.text}, which is not a constant path this reader follows, so nothing about what it does was read here`
          : `This field is wired to ${ref.text}, which this run did not read, so nothing about what it does was read here`,
        range,
      ),
    };
  }

  const targetQualifiedName = reached.name;
  const ancestry = await ancestryOf(
    targetQualifiedName,
    reached.blocks,
    ctx.lookup,
  );
  const body = bodyFromLookup(
    methodInAncestry(ancestry, ctx.pattern.resolverMethodName, ctx.read),
    range,
    `This field's ${targetQualifiedName}`,
    methodNotSettled(
      `This field is wired to ${targetQualifiedName}, which defines no ${ctx.pattern.resolverMethodName} method anywhere in its ancestry, so nothing about what it does was read here`,
      range,
    ),
    ctx.bodyRead,
  );
  const hooks =
    ctx.pattern.resolverHooks === undefined
      ? { definitions: [], unsettled: [] }
      : hooksRun(ancestry, ctx.pattern.resolverHooks, ctx.read);
  return {
    contract: await fieldContract(
      own,
      readClassDeclaration(ancestry, ctx.pattern),
      ctx,
    ),
    body: {
      ...body,
      readings: [
        ...body.readings,
        ...hooks.unsettled.map((one) =>
          unsettledHookReading(targetQualifiedName, one, range),
        ),
      ],
    },
    hooks: hooks.definitions,
  };
}

/** The class a constant written in `file` settles on through the facts, in whichever file of the run declares it, or null for a class the run never read. */
async function classInRun(
  ref: RbNode,
  file: string,
  ctx: Omit<FieldReadContext, "types">,
): Promise<{ name: string; blocks: ReachedBody[] } | null> {
  const inRun = ctx.lookup.definedInRun;
  if (ctx.facts === undefined || inRun === undefined) {
    return null;
  }
  const classKey = classSettledOn(ctx.facts, readKey(file, ref, null));
  const name =
    classKey === undefined ? undefined : declaredName(ctx.facts, classKey);
  if (name === undefined) {
    return null;
  }
  const blocks = await inRun(name);
  return blocks === null ? null : { name, blocks };
}

/** What a wired class declares about the field it resolves. */
interface ClassDeclaration {
  /** The class's type call, which declares the field's type. */
  type: DeclaredType;
  /** Built from field calls, which a class with no type call uses to describe its payload. */
  payload: Record<string, TypeShape>;
  args: ArgDeclaration[];
  methodArgs?: ArgDeclaration[];
  ancestry: Ancestry;
}

interface ClassContractAccumulator {
  type: DeclaredType;
  fieldProperties: Record<string, TypeShape>;
  args: Map<string, ArgDeclaration>;
}

type ClassCallHandler = (
  callArgs: CallArgs,
  written: { scope: FileScope; file: string },
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
) => void;

function readTypeCall(
  callArgs: CallArgs,
  written: { scope: FileScope; file: string },
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const typeArg = callArgs.positional[0];
  if (typeArg !== undefined) {
    out.type = {
      written: { node: typeArg, ...written },
      nullable: nullKeywordOf(callArgs, pattern) ?? out.type.nullable,
    };
  }
}

/** `null false` in a class body, which says whether the field it resolves can be null. */
function readNullCall(
  callArgs: CallArgs,
  _written: { scope: FileScope; file: string },
  _pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const value = callArgs.positional[0];
  const nullable = value === undefined ? null : booleanLiteralValue(value);
  if (nullable !== null) {
    out.type = { ...out.type, nullable };
  }
}

function readPayloadFieldCall(
  callArgs: CallArgs,
  { scope }: { scope: FileScope; file: string },
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const nameArg = callArgs.positional[0];
  const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
  const typeArg = ownTypeNode(callArgs, pattern);
  if (symbol === null || typeArg === undefined) {
    return;
  }
  const name = resolvedName(symbol, callArgs, pattern);
  out.fieldProperties[name] = typeShapeFromNode(
    typeArg,
    typeContext(scope, pattern),
  ) ?? { type: "unknown" };
}

function readArgumentCall(
  callArgs: CallArgs,
  { scope }: { scope: FileScope; file: string },
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const nameArg = callArgs.positional[0];
  const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
  if (symbol === null) {
    return;
  }
  const typeArg = callArgs.positional[1];
  const shape =
    typeArg !== undefined
      ? typeShapeFromNode(typeArg, typeContext(scope, pattern))
      : null;
  const requiredNode = callArgs.keyword[pattern.requiredKeyword];
  const required =
    requiredNode !== undefined
      ? (booleanLiteralValue(requiredNode) ?? pattern.requiredDefault)
      : pattern.requiredDefault;
  const name = resolvedName(symbol, callArgs, pattern);
  out.args.set(name, {
    name,
    type: shape ?? { type: "unknown" },
    required,
    typeText: typeArg?.text ?? null,
  });
}

function classCallHandlers(
  pattern: GraphqlObjectFields,
): Record<string, ClassCallHandler> {
  const nullCall = pattern.nullability?.callName;
  return {
    ...(nullCall === undefined ? {} : { [nullCall]: readNullCall }),
    [pattern.typeCallName]: readTypeCall,
    [pattern.fieldCallName]: readPayloadFieldCall,
    [pattern.argumentCallName]: readArgumentCall,
  };
}

/** What a wired class declares across its ancestry, a nearer declaration replacing what it inherits. */
function readClassDeclaration(
  ancestry: Ancestry,
  pattern: GraphqlObjectFields,
): ClassDeclaration {
  const out: ClassContractAccumulator = {
    type: { written: null, nullable: null },
    fieldProperties: {},
    args: new Map(),
  };
  const handlers = classCallHandlers(pattern);

  for (const { block, statement } of inheritedStatements(
    ancestry,
    blockConfiguresCall(pattern),
  )) {
    if (statement.type !== "call" || field(statement, "receiver") !== null) {
      continue;
    }
    const method = field(statement, "method")?.text;
    const handler = method !== undefined ? handlers[method] : undefined;
    if (handler === undefined) {
      continue;
    }
    const scope: FileScope = {
      nesting: block.info.bodyNesting,
      knownClasses: block.knownClasses,
    };
    handler(
      readCallArgs(field(statement, "arguments")),
      { scope, file: block.file },
      pattern,
      out,
    );
  }

  const args = [...out.args.values()];
  const declared = {
    type: out.type,
    payload: out.fieldProperties,
    ancestry,
  };
  const wrapping = pattern.argumentWrapping;
  if (wrapping !== undefined && ancestryReaches(ancestry, wrapping)) {
    return {
      ...declared,
      args: [wrapInputArgument(args, wrapping)],
      methodArgs: args,
    };
  }

  return { ...declared, args };
}

type ArgumentWrapping = NonNullable<GraphqlObjectFields["argumentWrapping"]>;

/** Checked by name, so the wrapping base matches even when its file was not read. */
function ancestryReaches(
  ancestry: Ancestry,
  wrapping: ArgumentWrapping,
): boolean {
  return ancestry.some((entry) => entry.name === wrapping.ancestorClassName);
}

/**
 * The wire shape the wrapping base class gives a mutation: one required
 * input-object argument. Its fields are the declared arguments, with
 * optional ones unioned with undefined, plus the fields the library adds.
 */
function wrapInputArgument(
  args: readonly ArgDeclaration[],
  wrapping: ArgumentWrapping,
): ArgDeclaration {
  const properties: Record<string, TypeShape> = {};
  for (const arg of args) {
    properties[arg.name] = arg.required ? arg.type : optionalShape(arg.type);
  }
  for (const [name, extra] of Object.entries(wrapping.extraFields)) {
    properties[name] = extra.required ? extra.type : optionalShape(extra.type);
  }
  return {
    name: wrapping.argumentName,
    type: { type: "record", properties },
    required: true,
    typeText: null,
  };
}

function optionalShape(shape: TypeShape): TypeShape {
  return { type: "union", variants: [shape, { type: "undefined" }] };
}

function buildFieldUnit(
  pack: RubyPack,
  pattern: GraphqlObjectFields,
  typeName: string,
  decl: FieldDeclaration,
  options: DiscoveryOptions,
): RawCodeStructure {
  const filePath = options.filePath;
  const declared = decl.contract?.output?.definitions ?? {};
  const definitions = Object.keys(declared).length === 0 ? undefined : declared;
  const wrappers = decl.hooks.map((hook) =>
    hookReference(hook, displayPathIn(options, hook.block.file)),
  );
  const parameters: RawParameter[] = (
    decl.contract?.methodArgs ??
    decl.contract?.args ??
    []
  ).map((arg, position) => ({
    name: arg.name,
    position,
    role: "args",
    typeText: arg.typeText,
  }));

  const graphqlDeclaredContract:
    | (GraphqlDeclaredContract & { provenance: "derived" })
    | undefined =
    decl.contract !== null
      ? {
          returnType: decl.contract.returnType,
          args: decl.contract.args.map((a) => ({
            name: a.name,
            type: a.type,
            required: a.required,
          })),
          provenance: "derived",
          framework: pack.name,
        }
      : undefined;

  return {
    identity: {
      name: `${typeName}.${decl.fieldName}`,
      nameKind: "label",
      kind: "resolver",
      file: filePath,
      range: rangeOf(decl.node),
      span: spanOf(decl.node),
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: decl.namedOnTheWire
      ? graphqlResolverBinding({
          transport: pack.protocol,
          recognition: pack.name,
          typeName,
          fieldName: decl.fieldName,
        })
      : null,
    parameters,
    branches: branchesFor(decl, pattern, options.facts),
    ...(decl.body.bodyContent !== undefined
      ? { bodyContent: decl.body.bodyContent }
      : {}),
    dependencyCalls: [],
    declaredContract: null,
    ...(definitions === undefined ? {} : { definitions }),
    ...(decl.body.readings.length > 0 ? { readings: decl.body.readings } : {}),
    ...(graphqlDeclaredContract !== undefined
      ? { graphqlDeclaredContract }
      : {}),
    ...(wrappers.length > 0 ? { wrappers } : {}),
  };
}
