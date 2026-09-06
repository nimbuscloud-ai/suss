/**
 * The whole extraction, from a tsconfig to a set of behavioral
 * summaries. `createTypeScriptAdapter` is what a caller uses;
 * everything else here is a stage of the run it drives.
 *
 * A run loads the project, asks each pack which files it cares about,
 * discovers units in those files, walks each unit's body for terminals
 * and effects, works out the boundary the unit is on, and assembles a
 * summary. Several passes then run over the finished set: mount
 * prefixes, module-load behavior, the reachable closure, rethrow
 * sources, wrapper expansion, sub-units, and naming. The adapter owns
 * what TypeScript and ECMAScript define; what a call means to a
 * framework or a runtime belongs to a pack.
 */

import path from "node:path";

import {
  type BindingElement,
  type CallExpression,
  type Identifier,
  Node,
  type ParameterDeclaration,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

import {
  functionCallBinding,
  graphqlOperationBinding,
  graphqlResolverBinding,
  messageBusBinding,
  packageExportBinding,
  readGraphqlMetadata,
  readSourceDocumentMetadata,
  restBinding,
  unitInvocationBinding,
  withGraphqlMetadata,
  withSourceDocumentMetadata,
} from "@suss/behavioral-ir";
import { Database } from "@suss/datalog";
import {
  type AccessRecognizer,
  assembleSummary,
  type BindingExtraction,
  type CacheAttribution,
  type CacheDiagnostic,
  type CacheInput,
  type CacheLayer,
  composeWrappers,
  createCacheLayer,
  type DiscoveredSubUnit,
  type DiscoveredSubUnitParent,
  type DiscoveryPattern,
  type ExtractorOptions,
  type InputMappingPattern,
  type InvocationRecognizer,
  type LanguageAdapter,
  type PartialPlan,
  type PatternPack,
  type RawBranch,
  type RawCodeStructure,
  type RawDependencyCall,
  type RawParameter,
  type ResponsePropertyMapping,
  type RootRecord,
  runDigest,
  stampModuleImports,
  type TerminalPattern,
} from "@suss/extractor";

import {
  bodyContentOf,
  countUnmatchedReturns,
  extractRawBranches,
} from "./assembly.js";
import {
  createLazyProject,
  type DeepImportGraphs,
  loadImportGraphsDepthFirst,
  loadImportGraphsDepthFirstFromPaths,
  readTsconfigFileList,
} from "./bootstrap/lazyProjectInit.js";
import { computePackApplicability } from "./bootstrap/preFilter.js";
import {
  createSourceFileLookup,
  type SourceFileLookup,
} from "./bootstrap/sourceFileLookup.js";
import { readContract, readContractForClientCall } from "./contract.js";
import {
  createDependencySink,
  type DependencySink,
  recordFileDependency,
  recordUnitClaim,
  withDependencySink,
} from "./depTracking.js";
import {
  buildExtractionReport,
  commonDirectoryOf,
  createPackTallies,
  type ExtractionReport,
  type PackTally,
  recordPackFailure,
} from "./diagnostics.js";
import { routePathFromFile } from "./discovery/filenameRoute.js";
import { stampGraphqlClientRefs } from "./discovery/graphqlClientConstruction.js";
import {
  buildProjectHelperIndex,
  type ProjectHelperIndex,
} from "./discovery/helperIndex.js";
import {
  type DiscoveredUnit,
  discoverUnits,
  unitDedupKey,
} from "./discovery/index.js";
import {
  buildMountPrefixIndex,
  type MountPrefixIndex,
} from "./discovery/mountPrefix.js";
import { readRegisteringFiles } from "./discovery/registrationCall.js";
import { stringPropertyOf } from "./discovery/resolveValue.js";
import {
  buildWrapperIndex,
  type WrapperIndex,
} from "./discovery/wrapperIndex.js";
import { createTsDiscoveryContext } from "./discoveryContext.js";
import {
  forgetReassignedNamesUnstated,
  reassignedNamesUnstated,
} from "./facts/extract.js";
import { ResolutionStore } from "./facts/store.js";
import { deriveGraphqlContract } from "./graphqlContract.js";
import { endLineOf, startLineOf } from "./lines.js";
import {
  forgetUnreadableExportFiles,
  noteUnreadableExports,
  unreadableExportFiles,
  warmExportChains,
} from "./moduleExports.js";
import { moduleInitSummary } from "./moduleInit.js";
import { parameterReads } from "./parameterReads.js";
import { createReferenceIndex } from "./referencedFiles.js";
import {
  type ClosureFacts,
  deriveBoundaryEffects,
} from "./resolve/boundaryEffects.js";
import { runAccessRecognizersAtModuleScope } from "./resolve/invocationEffects.js";
import {
  expandReachableClosure,
  recognizerOnlyRoots,
} from "./resolve/reachableClosure.js";
import { enrichRethrows } from "./resolve/rethrowEnrichment.js";
import { pathFromArgument } from "./resolve/routePath.js";
import { sourceDeclarationsBehind } from "./resolve/sourceDeclaration.js";
import { unfollowedCallGap } from "./resolve/unfollowedCall.js";
import { withDefinitions } from "./shapes/definitions.js";
import { collectClientFieldAccesses } from "./shapes/fieldAccesses.js";
import {
  createTsSubUnitContext,
  type TsSubUnitContext,
} from "./subUnitContext.js";
import {
  nameSummaries,
  workspaceNameFor,
  workspaceRootFor,
} from "./summaryIdentity.js";
import { createTimer, type Timer, type TimingReport } from "./timing.js";
import {
  computeAdapterPacksDigest,
  declineWhenRunFromSource,
} from "./version.js";
import {
  type DescentBarriers,
  isDescentStop,
  NO_BARRIERS,
} from "./walk/descent.js";
import {
  expandWorkspacePatterns,
  workspaceExpansionStamp,
} from "./workspacePatterns.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  CodeUnitKind,
  Effect,
  Predicate,
  UnfollowedCall,
  ValueRef,
} from "@suss/behavioral-ir";
import type { FunctionRoot } from "./conditions.js";
import type {
  AnchorCallsOf,
  OriginatesFrom,
} from "./resolve/invocationEffects.js";
import type { ResolveCallee } from "./terminals/helperResolution.js";

const raise = (msg: string): never => {
  throw new Error(msg);
};

function bindingPatternNames(nameNode: Node): string[] | null {
  if (Node.isObjectBindingPattern(nameNode)) {
    return nameNode.getElements().map((e) => e.getName());
  }
  if (Node.isArrayBindingPattern(nameNode)) {
    const names: string[] = [];
    for (const element of nameNode.getElements()) {
      if (Node.isOmittedExpression(element)) {
        continue;
      }
      names.push(element.getName());
    }
    return names;
  }
  return null;
}

/**
 * One input per property the handler binds, or one for the parameter
 * itself when it takes the object whole. A handler that writes
 * `{ params }` says it reads the path parameters; one that writes `args`
 * says nothing about which properties it reads, so the whole object is
 * the input.
 */
function objectParamInputs(
  param: ParameterDeclaration,
  position: number,
  mapping: Extract<InputMappingPattern, { type: "objectParam" }>,
): RawParameter[] {
  const boundNames = bindingPatternNames(param.getNameNode());
  if (boundNames === null) {
    return [
      {
        name: param.getName(),
        position,
        role: mapping.wholeParamRole ?? "request",
        typeText: null,
      },
    ];
  }
  return boundNames.map((name) => ({
    name,
    position,
    role: mapping.knownProperties[name] ?? name,
    typeText: null,
  }));
}

function componentPropsParameters(
  param: ParameterDeclaration,
  mapping: Extract<InputMappingPattern, { type: "componentProps" }>,
): RawParameter[] {
  const nameNode = param.getNameNode();
  if (!Node.isObjectBindingPattern(nameNode)) {
    const type = param.getType();
    return [
      {
        name: param.getName(),
        position: mapping.paramPosition,
        role: mapping.wholeParamRole ?? "props",
        typeText: type.getText() || null,
      },
    ];
  }
  return nameNode.getElements().map((element) => {
    const name = element.getName();
    const typeText = element.getType().getText();
    return {
      name,
      position: mapping.paramPosition,
      role: bindingRole(element, name),
      typeText: typeText.length > 0 ? typeText : null,
    };
  });
}

/**
 * The name the caller passes, for a destructured binding's role. A
 * rename (`totalCount: _totalCount`) reads under the binding's name
 * while the boundary's word is the property's, and a rest binding
 * collects whatever was passed, so its role says so.
 */
function bindingRole(element: BindingElement, name: string): string {
  if (element.getDotDotDotToken() !== undefined) {
    return "rest";
  }
  const property = element.getPropertyNameNode();
  if (property === undefined) {
    return name;
  }
  if (Node.isStringLiteral(property)) {
    return property.getLiteralValue();
  }
  return property.getText();
}

function extractParameters(
  func: FunctionRoot,
  inputMapping: InputMappingPattern,
): RawParameter[] {
  const params = func.getParameters();
  const result: RawParameter[] = [];

  if (inputMapping.type === "positionalParams") {
    for (const mapping of inputMapping.params) {
      const param = params[mapping.position];
      if (param === undefined) {
        continue;
      }
      result.push({
        name: param.getName(),
        position: mapping.position,
        role: mapping.role,
        typeText: null,
      });
    }
  } else if (inputMapping.type === "objectParam") {
    const position = inputMapping.paramPosition ?? 0;
    const param = params[position];
    if (param !== undefined) {
      result.push(...objectParamInputs(param, position, inputMapping));
    }
  } else if (inputMapping.type === "allPositional") {
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const nameNode = param.getNameNode();
      const boundNames = bindingPatternNames(nameNode);
      if (Node.isObjectBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
          result.push({
            name: element.getName(),
            position: i,
            role:
              inputMapping.defaultRole ??
              bindingRole(element, element.getName()),
            typeText: null,
          });
        }
      } else if (boundNames !== null) {
        for (const name of boundNames) {
          result.push({
            name,
            position: i,
            role: inputMapping.defaultRole ?? name,
            typeText: null,
          });
        }
      } else {
        const name = param.getName();
        result.push({
          name,
          position: i,
          role: inputMapping.defaultRole ?? name,
          typeText: null,
        });
      }
    }
  } else if (inputMapping.type === "decoratedParams") {
    // Skipping an undecorated parameter keeps an injected service from
    // surfacing as an input.
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const decorators = param.getDecorators();
      let matchedRole: string | null = null;
      for (const decorator of decorators) {
        const decoratorName = decorator.getName();
        const role = inputMapping.decoratorRoleMap[decoratorName];
        if (role !== undefined) {
          matchedRole = role;
          break;
        }
      }
      const role = matchedRole ?? inputMapping.defaultRole;
      if (role === undefined) {
        continue;
      }
      result.push({
        name: param.getName(),
        position: i,
        role,
        typeText: null,
      });
    }
  } else if (inputMapping.type === "componentProps") {
    const param = params[inputMapping.paramPosition];
    if (param !== undefined) {
      result.push(...componentPropsParameters(param, inputMapping));
    }
  }

  return result;
}

function extractDependencyCalls(
  func: FunctionRoot,
  barriers: DescentBarriers = NO_BARRIERS,
): RawDependencyCall[] {
  const results: RawDependencyCall[] = [];

  func.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, func, barriers)) {
      traversal.skip();
      return;
    }

    if (!Node.isVariableDeclaration(node)) {
      return;
    }

    const init = node.getInitializer();
    if (init === undefined) {
      return;
    }

    let isAsync = false;
    let callExpr = init;
    if (Node.isAwaitExpression(init)) {
      isAsync = true;
      callExpr = init.getExpression();
    }

    if (!Node.isCallExpression(callExpr)) {
      return;
    }

    const calleeName = callExpr.getExpression().getText();

    const nameNode = node.getNameNode();
    const assignedTo = Node.isIdentifier(nameNode) ? nameNode.getText() : null;

    const declList = node.getParent();
    const varStmt = declList?.getParent();
    const locationNode =
      varStmt !== undefined && Node.isVariableStatement(varStmt)
        ? varStmt
        : node;

    results.push({
      name: calleeName,
      assignedTo,
      async: isAsync,
      returnType: null,
      location: {
        start: startLineOf(locationNode),
        end: endLineOf(locationNode),
      },
    });
  });

  return results;
}

/** A truthiness check on fetch's `.ok` becomes a status range comparison. */
function resolveResponseProperties(
  branches: RawBranch[],
  calleeText: string,
  semantics: ResponsePropertyMapping[],
): RawBranch[] {
  return branches.map((branch) => ({
    ...branch,
    conditions: branch.conditions.map((cond) => ({
      ...cond,
      structured: cond.structured
        ? resolveResponsePredicate(cond.structured, calleeText, semantics)
        : null,
    })),
  }));
}

function resolveResponsePredicate(
  pred: Predicate,
  calleeText: string,
  semantics: ResponsePropertyMapping[],
): Predicate {
  if (pred.type === "truthinessCheck") {
    const resolved = tryResolveStatusRange(pred.subject, calleeText, semantics);
    if (resolved !== null) {
      return pred.negated ? { type: "negation", operand: resolved } : resolved;
    }
  }

  if (pred.type === "compound") {
    return {
      ...pred,
      operands: pred.operands.map((op) =>
        resolveResponsePredicate(op, calleeText, semantics),
      ),
    };
  }

  if (pred.type === "negation") {
    return {
      ...pred,
      operand: resolveResponsePredicate(pred.operand, calleeText, semantics),
    };
  }

  return pred;
}

function tryResolveStatusRange(
  ref: ValueRef,
  calleeText: string,
  semantics: ResponsePropertyMapping[],
): Predicate | null {
  if (ref.type !== "derived" || ref.derivation.type !== "propertyAccess") {
    return null;
  }

  const baseRef = ref.from;
  if (
    baseRef.type !== "dependency" ||
    baseRef.name !== calleeText ||
    baseRef.accessChain.length !== 0
  ) {
    return null;
  }

  const propName = ref.derivation.property;
  const mapping = semantics.find(
    (s) =>
      s.name === propName &&
      s.access === "property" &&
      s.semantics.type === "statusRange",
  );
  if (mapping === undefined || mapping.semantics.type !== "statusRange") {
    return null;
  }

  const statusRef: ValueRef = {
    type: "derived",
    from: baseRef,
    derivation: { type: "propertyAccess", property: "status" },
  };

  return {
    type: "compound",
    op: "and",
    operands: [
      {
        type: "comparison",
        left: statusRef,
        op: "gte",
        right: { type: "literal", value: mapping.semantics.min },
      },
      {
        type: "comparison",
        left: statusRef,
        op: "lte",
        right: { type: "literal", value: mapping.semantics.max },
      },
    ],
  };
}

// There is no body to read, so record that on `bodyContent`. Otherwise
// the summary looks like a handler that does nothing.
function announcedBoundaryStructure(unit: DiscoveredUnit): RawCodeStructure {
  const at = unit.announcedAt;
  if (at === undefined) {
    throw new Error(
      `discovery produced the unit "${unit.name}" with neither a function nor the registration that announced it`,
    );
  }
  return {
    identity: {
      name: unit.name,
      ...(unit.nameKind !== undefined ? { nameKind: unit.nameKind } : {}),
      kind: unit.kind as CodeUnitKind,
      file: at.getSourceFile().getFilePath(),
      range: { start: at.getStartLineNumber(), end: at.getEndLineNumber() },
      span: { start: at.getStart(), end: at.getEnd() },
      exportName: unit.name,
      exportPath: [unit.name],
    },
    boundaryBinding: null,
    parameters: [],
    branches: [],
    bodyContent: "elsewhere",
    dependencyCalls: [],
    declaredContract: null,
  };
}

export function extractCodeStructure(
  unit: DiscoveredUnit,
  pack: PatternPack,
  invocationRecognizers: InvocationRecognizer[] = [],
  accessRecognizers: AccessRecognizer[] = [],
  barriers: DescentBarriers = NO_BARRIERS,
  resolution?: ResolutionStore,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
  resolveCallee?: ResolveCallee,
): RawCodeStructure {
  // One table per unit: every shape read during this call goes into it.
  const read = withDefinitions(() =>
    readCodeStructure(
      unit,
      pack,
      invocationRecognizers,
      accessRecognizers,
      barriers,
      resolution,
      originatesFrom,
      anchorCallsOf,
      resolveCallee,
    ),
  );
  return read.definitions === null
    ? read.value
    : { ...read.value, definitions: read.definitions };
}

function responseAccessorNames(
  pack: PatternPack,
  kind: ResponsePropertyMapping["semantics"]["type"],
): string[] | undefined {
  return pack.responseSemantics
    ?.filter((m) => m.semantics.type === kind)
    .map((m) => m.name);
}

/**
 * The pack's response properties, grouped the way the checker asks for
 * them: how a consumer reaches the body, the status, and the success
 * flag. A kind the pack declares nothing for is left out entirely, so
 * the checker never sees an empty list and reads it as "this pack has no
 * accessors" when it means "this pack did not say".
 */
const ACCESSOR_FIELD_SEMANTICS = {
  bodyAccessors: "body",
  statusAccessors: "statusCode",
  successAccessors: "statusRange",
} as const satisfies Record<
  string,
  ResponsePropertyMapping["semantics"]["type"]
>;

function responseAccessors(
  pack: PatternPack,
): Partial<Record<keyof typeof ACCESSOR_FIELD_SEMANTICS, string[]>> {
  const out: Partial<Record<keyof typeof ACCESSOR_FIELD_SEMANTICS, string[]>> =
    {};
  for (const [field, kind] of Object.entries(ACCESSOR_FIELD_SEMANTICS)) {
    const names = responseAccessorNames(pack, kind);
    if (names !== undefined && names.length > 0) {
      out[field as keyof typeof ACCESSOR_FIELD_SEMANTICS] = names;
    }
  }
  return out;
}

/**
 * A function that ends without returning still ends. Whether that
 * counts as a terminal is the pack's call, and an HTTP handler says no,
 * because a handler that sends no response should come out with none.
 */
const FUNCTION_FALLTHROUGH_TERMINAL: TerminalPattern = {
  kind: "return",
  match: { type: "functionFallthrough" },
  extraction: {},
};

/**
 * Where the framework puts the thrown value in this unit's parameters,
 * for a wrapper it only calls when something threw. Undefined for
 * everything else, which is every unit that is not an error handler.
 */
function thrownValueAt(unit: DiscoveredUnit): number | undefined {
  return unit.pattern?.wraps?.throwParam;
}

/**
 * A pack's terminals as they read inside such a wrapper. Express calls
 * an error handler with `(err, req, res, next)` and a handler with
 * `(req, res, next)`, so the response object is one parameter further
 * along than the pack says.
 */
function pastThrownValue(
  terminals: TerminalPattern[],
  at: number | undefined,
): TerminalPattern[] {
  if (at === undefined) {
    return terminals;
  }
  return terminals.map((pattern) =>
    pattern.match.type === "parameterMethodCall" &&
    pattern.match.parameterPosition >= at
      ? {
          ...pattern,
          match: {
            ...pattern.match,
            parameterPosition: pattern.match.parameterPosition + 1,
          },
        }
      : pattern,
  );
}

/** The same shift, for the role the pack gives each parameter. */
function rolesPastThrownValue(
  mapping: InputMappingPattern,
  at: number | undefined,
): InputMappingPattern {
  if (at === undefined || mapping.type !== "positionalParams") {
    return mapping;
  }
  return {
    type: "positionalParams",
    params: mapping.params.map((param) =>
      param.position >= at ? { ...param, position: param.position + 1 } : param,
    ),
  };
}

/**
 * The terminal for a wrapper's call to its continuation, when the
 * pattern that found it says where the continuation is. A path that
 * reaches it hands control to the wrapped unit, so composition splices
 * that unit in there; a path that never reaches it ends on its own.
 */
function continuationTerminal(unit: DiscoveredUnit): TerminalPattern[] {
  const at = unit.pattern?.wraps?.continuationParam;
  if (at === undefined) {
    return [];
  }
  return [
    {
      kind: "delegate",
      match: { type: "parameterCall", parameterPosition: at },
      extraction: {},
    },
  ];
}

/**
 * The terminals to read this unit's body with. A consumer gets the
 * fall-through terminal whether or not its pack asked for one, because
 * the code around a client call runs off the end of its function all
 * the time, and without a branch for that the success half of
 * `if (!res.ok) { toast.error(...); return }` is missing.
 */
function terminalsFor(
  unit: DiscoveredUnit,
  pack: PatternPack,
): TerminalPattern[] {
  // A pack whose units follow more than one convention overrides the
  // pack-level terminals per unit.
  const declared = [
    ...(unit.terminals ?? pastThrownValue(pack.terminals, thrownValueAt(unit))),
    ...continuationTerminal(unit),
  ];
  if (unit.callSite === undefined) {
    return declared;
  }
  if (declared.some((p) => p.match.type === "functionFallthrough")) {
    return declared;
  }
  return [...declared, FUNCTION_FALLTHROUGH_TERMINAL];
}

function readCodeStructure(
  unit: DiscoveredUnit,
  pack: PatternPack,
  invocationRecognizers: InvocationRecognizer[],
  accessRecognizers: AccessRecognizer[],
  barriers: DescentBarriers,
  resolution?: ResolutionStore,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
  resolveCallee?: ResolveCallee,
): RawCodeStructure {
  const { func, kind, name } = unit;
  if (func === null) {
    return announcedBoundaryStructure(unit);
  }
  // A pack whose units follow more than one convention overrides the
  // pack-level input mapping per unit.
  const params = extractParameters(
    func,
    unit.inputMapping ??
      rolesPastThrownValue(pack.inputMapping, thrownValueAt(unit)),
  );
  const extracted = extractRawBranches(
    func,
    terminalsFor(unit, pack),
    invocationRecognizers,
    accessRecognizers,
    barriers,
    resolution,
    originatesFrom,
    anchorCallsOf,
    resolveCallee,
  );
  let branches = extracted.branches;
  const unmatchedReturns = countUnmatchedReturns(
    func,
    extracted.terminals,
    barriers,
  );
  const depCalls = extractDependencyCalls(func, barriers);
  const paramReads = parameterReads(
    func,
    params.map((one) => one.name),
    barriers,
  );

  if (unit.callSite !== undefined) {
    const calleeText = unit.callSite.callExpression.getExpression().getText();

    if (pack.responseSemantics !== undefined) {
      branches = resolveResponseProperties(
        branches,
        calleeText,
        pack.responseSemantics,
      );
    }

    const branchLocations = branches.map((b) => b.location);
    const fieldAccesses = collectClientFieldAccesses(
      unit.callSite.callExpression,
      func,
      branchLocations,
      pack.responseSemantics,
    );
    for (let i = 0; i < branches.length; i++) {
      const access = fieldAccesses[i];
      if (access?.expectedInput != null) {
        branches[i] = { ...branches[i], expectedInput: access.expectedInput };
      }
    }
  }

  const accessors = unit.callSite !== undefined ? responseAccessors(pack) : {};

  return {
    identity: {
      name,
      ...(unit.nameKind !== undefined ? { nameKind: unit.nameKind } : {}),
      kind: kind as CodeUnitKind,
      // The range below comes from the function itself, so the path has
      // to as well. Discovery can walk a barrel and end up on a
      // declaration re-exported from another module.
      file: func.getSourceFile().getFilePath(),
      range: {
        start: startLineOf(func),
        end: endLineOf(func),
      },
      span: { start: func.getStart(), end: func.getEnd() },
      exportName: name,
      exportPath: [name],
    },
    boundaryBinding: null,
    parameters: params,
    branches,
    ...(unmatchedReturns > 0 ? { unmatchedReturns } : {}),
    bodyContent: bodyContentOf(func),
    dependencyCalls: depCalls,
    declaredContract: null,
    ...(paramReads.length > 0 ? { extraInputReads: paramReads } : {}),
    ...accessors,
    ...(unit.callSite !== undefined && pack.failureDelivery !== undefined
      ? { failureDelivery: pack.failureDelivery }
      : {}),
  };
}

function extractConsumerBinding(
  unit: DiscoveredUnit,
  pattern: DiscoveryPattern,
  pack: PatternPack,
  resolution?: ResolutionStore,
): BoundaryBinding | null {
  const callSite = unit.callSite;
  if (callSite === undefined) {
    return null;
  }

  const binding = pattern.bindingExtraction;
  if (binding === undefined) {
    return null;
  }

  const method = extractBindingMethod(binding, callSite, pack, resolution);
  const path = extractBindingPath(binding, callSite, pack, resolution);

  // Wrapper expansion looks for a null `path` to spot a forwarding
  // wrapper, so return a partial binding rather than nothing.
  return restBinding({
    transport: pack.protocol,
    method: method ?? null,
    path: path ?? null,
    recognition: pack.name,
  });
}

function fileRouteBinding(
  filePath: string,
  unit: DiscoveredUnit,
  binding: BindingExtraction,
  pack: PatternPack,
): BoundaryBinding | null {
  if (binding.path.type !== "fromFilename") {
    return null;
  }
  const routePath = routePathFromFile(filePath, binding.path);
  if (routePath === null) {
    return null;
  }
  const method = fileRouteMethod(binding, unit);
  if (method === undefined) {
    return null;
  }
  return restBinding({
    transport: pack.protocol,
    recognition: pack.name,
    method,
    path: routePath,
  });
}

function fileRouteMethod(
  binding: BindingExtraction,
  unit: DiscoveredUnit,
): string | undefined {
  if (binding.method.type === "literal") {
    return binding.method.value;
  }
  if (binding.method.type === "fromExportName") {
    return unit.name.toUpperCase();
  }
  return undefined;
}

function extractBindingMethod(
  binding: BindingExtraction,
  callSite: NonNullable<DiscoveredUnit["callSite"]>,
  pack: PatternPack,
  resolution?: ResolutionStore,
): string | undefined {
  const m = binding.method;
  if (m.type === "fromClientMethod") {
    return resolveContractField(callSite, pack, "method", resolution);
  }
  if (m.type === "fromArgumentProperty") {
    const arg = callSite.callExpression.getArguments()[m.position];
    const value =
      arg === undefined ? null : stringPropertyOf(arg, m.property, resolution);
    return value ?? m.default;
  }
  if (m.type === "literal") {
    return m.value;
  }
  return undefined;
}

function extractBindingPath(
  binding: BindingExtraction,
  callSite: NonNullable<DiscoveredUnit["callSite"]>,
  pack: PatternPack,
  resolution?: ResolutionStore,
): string | undefined {
  const p = binding.path;
  if (p.type === "fromClientMethod") {
    return resolveContractField(callSite, pack, "path", resolution);
  }
  if (p.type === "fromArgument") {
    const arg = callSite.callExpression.getArguments()[p.position];
    return arg === undefined ? undefined : pathFromArgument(arg, resolution);
  }
  return undefined;
}

function resolveContractField(
  callSite: NonNullable<DiscoveredUnit["callSite"]>,
  pack: PatternPack,
  field: "method" | "path",
  resolution?: ResolutionStore,
): string | undefined {
  if (pack.contractReading === undefined || callSite.methodName === null) {
    return undefined;
  }
  const result = readContractForClientCall(
    callSite.callExpression,
    callSite.methodName,
    pack.contractReading,
    pack.name,
    resolution,
  );
  if (result === null || result.boundaryBinding === null) {
    return undefined;
  }
  const semantics = result.boundaryBinding.semantics;
  if (semantics.name !== "rest") {
    return undefined;
  }
  const value = field === "method" ? semantics.method : semantics.path;
  return value ?? undefined;
}

// Aggregation flattens every pack's recognizers into one list, so this
// is the last point at which a recognizer's owning pack is known.
function reportingTo<TCtx>(
  recognize: (node: unknown, ctx: TCtx) => Effect[] | null,
  tally: PackTally,
): (node: unknown, ctx: TCtx) => Effect[] | null {
  return (node, ctx) => {
    const effects = recognize(node, ctx);
    if (effects !== null) {
      tally.effectsRecognized += effects.length;
    }
    return effects;
  };
}

function collectInvocationRecognizers(
  frameworks: PatternPack[],
  tallies?: Map<string, PackTally>,
): InvocationRecognizer[] {
  const out: InvocationRecognizer[] = [];
  for (const pack of frameworks) {
    if (pack.invocationRecognizers === undefined) {
      continue;
    }
    const tally = tallies?.get(pack.name);
    for (const recognize of pack.invocationRecognizers) {
      out.push(tally === undefined ? recognize : reportingTo(recognize, tally));
    }
  }
  return out;
}

function collectAccessRecognizers(
  frameworks: PatternPack[],
  tallies?: Map<string, PackTally>,
): AccessRecognizer[] {
  const out: AccessRecognizer[] = [];
  for (const pack of frameworks) {
    if (pack.accessRecognizers === undefined) {
      continue;
    }
    const tally = tallies?.get(pack.name);
    for (const recognize of pack.accessRecognizers) {
      out.push(tally === undefined ? recognize : reportingTo(recognize, tally));
    }
  }
  return out;
}

// Nested functions the body walkers stop at, so a sub-unit's behavior
// goes on its own summary and not the parent's as well. Every
// applicable pack's hook contributes, the way recognizers already come
// from every pack: a query callback inside a React component is still
// scheduled work. Has to stay in step with `synthesizeSubUnits`.
function computeSubUnitBarriers(
  unit: DiscoveredUnit,
  packs: ReadonlyArray<PatternPack>,
  ctx: TsSubUnitContext,
  tallies: Map<string, PackTally> | undefined,
  file: string,
): DescentBarriers {
  if (unit.func === null) {
    return NO_BARRIERS;
  }
  const parentHandle: DiscoveredSubUnitParent = {
    func: unit.func,
    name: unit.name,
    kind: unit.kind,
  };
  const barriers = new Set<Node>();
  for (const pack of packs) {
    if (pack.subUnits === undefined) {
      continue;
    }
    try {
      for (const su of pack.subUnits(parentHandle, ctx)) {
        barriers.add(su.func as Node);
      }
    } catch (err) {
      process.stderr.write(
        recordPackFailure(tallies?.get(pack.name), {
          pack: pack.name,
          hook: "subUnits",
          file,
          error: err,
        }),
      );
    }
  }
  return barriers.size === 0 ? NO_BARRIERS : barriers;
}

interface ClaimedUnit {
  pack: string;
  file: string;
}

function extractFromSourceFile(
  sourceFile: SourceFile,
  frameworks: PatternPack[],
  claimedUnits: Map<string, ClaimedUnit>,
  options?: ExtractorOptions,
  tallies?: Map<string, PackTally>,
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
  wrappers?: WrapperIndex,
  projectHelpers?: ProjectHelperIndex,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // Recognizers come from every pack, not the discovering one: a Prisma
  // call inside an Express handler is still a Prisma call. A contributed
  // one matches a call to a function this project itself declares.
  const allInvocationRecognizers = [
    ...collectInvocationRecognizers(frameworks, tallies),
    ...(projectHelpers?.contributedRecognizers() ?? []),
  ];
  const allAccessRecognizers = collectAccessRecognizers(frameworks, tallies);
  const gatedIn: PackTally[] = [];
  let unitsWalkedHere = 0;
  const subUnitCtx = createTsSubUnitContext();

  // Pack order in `frameworks` is the user's precedence: the first pack
  // to claim a (function, kind) keeps it. The map is per run, because a
  // barrel reaches the same function its declaring file does.
  const claimed = claimedUnits;

  for (const pack of frameworks) {
    const tally = tallies?.get(pack.name);
    const summariesBefore = summaries.length;
    if (tally !== undefined) {
      tally.candidateFiles += 1;
      gatedIn.push(tally);
    }

    const contributed = projectHelpers?.patternsFor(pack.name) ?? [];
    const units = discoverUnits(
      sourceFile,
      contributed.length === 0
        ? pack.discovery
        : [...pack.discovery, ...contributed],
      resolution,
      mountPrefixes,
      projectHelpers,
    );

    // The wrapper index settles which registrations are error handlers
    // and which are middleware before any of them becomes a unit, which
    // one pattern at a time cannot do.
    units.push(
      ...(wrappers?.unitsIn(sourceFile.getFilePath(), pack.name) ?? []),
    );

    // A pack no DiscoveryMatch variant fits does its own walking.
    if (pack.discoverUnits !== undefined) {
      const tsCtx = createTsDiscoveryContext(resolution);
      try {
        const customUnits = pack.discoverUnits(sourceFile, tsCtx);
        for (const cu of customUnits) {
          units.push({
            func: cu.func as FunctionRoot,
            kind: cu.kind,
            name: cu.name,
            ...(cu.terminals !== undefined ? { terminals: cu.terminals } : {}),
            ...(cu.inputMapping !== undefined
              ? { inputMapping: cu.inputMapping }
              : {}),
            ...(cu.routeInfo !== undefined ? { routeInfo: cu.routeInfo } : {}),
            ...(cu.resolverInfo !== undefined
              ? { resolverInfo: cu.resolverInfo }
              : {}),
            ...(cu.channelInfo !== undefined
              ? { channelInfo: cu.channelInfo }
              : {}),
            ...(cu.invocationInfo !== undefined
              ? { invocationInfo: cu.invocationInfo }
              : {}),
            ...(cu.deployableUnit !== undefined
              ? { deployableUnit: cu.deployableUnit }
              : {}),
            ...(cu.functionCallInfo !== undefined
              ? { functionCallInfo: cu.functionCallInfo }
              : {}),
            ...(cu.metadata !== undefined ? { metadata: cu.metadata } : {}),
          });
        }
      } catch (err) {
        process.stderr.write(
          recordPackFailure(tally, {
            pack: pack.name,
            hook: "discoverUnits",
            file: sourceFile.getFilePath(),
            error: err,
          }),
        );
      }
    }

    for (const unit of units) {
      const claimKey = unitDedupKey(unit);
      const claimant = claimed.get(claimKey);
      if (claimant !== undefined) {
        // One pack reaching the same function from two modules means a
        // barrel, so only a collision inside one file counts.
        if (
          claimant.pack === pack.name &&
          claimant.file === sourceFile.getFilePath() &&
          tally !== undefined
        ) {
          tally.selfCollisions += 1;
        }
        if (claimant.file !== sourceFile.getFilePath()) {
          // The other file's claim decided what this walk skipped, so a
          // change there has to re-extract this file.
          recordFileDependency(claimant.file);
        }
        continue;
      }
      claimed.set(claimKey, {
        pack: pack.name,
        file: sourceFile.getFilePath(),
      });
      recordUnitClaim(claimKey, pack.name);
      const declaringFile = unit.func?.getSourceFile().getFilePath();
      if (
        declaringFile !== undefined &&
        declaringFile !== sourceFile.getFilePath()
      ) {
        // Discovery walked this file and landed on a function written
        // in another one, whose body is what the summary reads.
        recordFileDependency(declaringFile);
      }
      unitsWalkedHere += 1;
      if (tally !== undefined) {
        tally.unitsClaimed += 1;
      }
      const barriers = computeSubUnitBarriers(
        unit,
        frameworks,
        subUnitCtx,
        tallies,
        sourceFile.getFilePath(),
      );
      const raw = extractCodeStructure(
        unit,
        pack,
        allInvocationRecognizers,
        allAccessRecognizers,
        barriers,
        resolution,
        resolution === undefined
          ? undefined
          : (value, module) =>
              resolution.importOriginsOf(value, [module]).length > 0,
        resolution === undefined
          ? undefined
          : (value, matches) => resolution.anchorCallsOf(value, matches),
        resolution === undefined
          ? undefined
          : (value) => resolution.resolveCallable(value),
      );

      // Set before the branches below, since both of them overwrite it
      // with whatever binding the unit ends up with.
      if (unit.deployableUnit !== undefined) {
        raw.deployableUnit = unit.deployableUnit;
      }
      if (unit.unreadBinding !== undefined) {
        raw.unreadBinding = unit.unreadBinding;
      }
      stampWrappers(raw, unit, wrappers);

      const matchedPattern =
        unit.pattern ?? pack.discovery.find((d) => d.kind === unit.kind);

      if (unit.resolverInfo !== undefined) {
        raw.boundaryBinding = graphqlResolverBinding({
          transport: pack.protocol,
          recognition: pack.name,
          typeName: unit.resolverInfo.typeName,
          fieldName: unit.resolverInfo.fieldName,
        });
        // Never guess a type for a resolver that declares none: the
        // guess would be a root field no schema has.
        if (unit.resolverInfo.typeName === null) {
          raw.unreadBinding = `The type whose field ${unit.resolverInfo.fieldName} belongs to is not stated where this resolver is written, so the binding names no type and nothing pairs with it`;
        }
        if (unit.resolverInfo.schemaSdl !== undefined) {
          raw.graphqlSchemaSdl = unit.resolverInfo.schemaSdl;
          if (unit.resolverInfo.schemaDocument !== undefined) {
            raw.sourceDocumentLabel = unit.resolverInfo.schemaDocument;
          }
          // With no declared type there is no schema entry to compare
          // against.
          if (unit.resolverInfo.typeName !== null) {
            const contract = deriveGraphqlContract(
              unit.resolverInfo.schemaSdl,
              unit.resolverInfo.typeName,
              unit.resolverInfo.fieldName,
              pack.name,
            );
            if (contract !== null) {
              raw.graphqlDeclaredContract = contract;
            }
          }
        }
      } else if (unit.routeInfo !== undefined) {
        raw.boundaryBinding = restBinding({
          transport: pack.protocol,
          recognition: pack.name,
          method: unit.routeInfo.method,
          path: unit.routeInfo.path,
        });
      } else if (unit.channelInfo !== undefined) {
        raw.boundaryBinding = messageBusBinding({
          recognition: pack.name,
          messageBus: unit.channelInfo.messageBus,
          channel: unit.channelInfo.channel,
        });
      } else if (unit.invocationInfo !== undefined) {
        raw.boundaryBinding = unitInvocationBinding({
          recognition: pack.name,
          deploymentTarget: unit.invocationInfo.deploymentTarget,
          instanceName: unit.invocationInfo.instanceName,
        });
      } else if (unit.operationInfo !== undefined) {
        raw.boundaryBinding = graphqlOperationBinding({
          transport: pack.protocol,
          recognition: pack.name,
          operationType: unit.operationInfo.operationType,
          ...(unit.operationInfo.operationName !== undefined
            ? { operationName: unit.operationInfo.operationName }
            : {}),
        });
        // Kept raw so the checker can re-parse it for shapes this does
        // not pull out.
        if (unit.operationInfo.document !== undefined) {
          raw.graphqlDocument = unit.operationInfo.document;
        }
        if (unit.operationInfo.unresolvedFragments !== undefined) {
          raw.graphqlUnresolvedFragments =
            unit.operationInfo.unresolvedFragments;
        }
        if (unit.operationInfo.unresolved !== undefined) {
          raw.graphqlUnresolvedDocument = unit.operationInfo.unresolved;
        }
        // Role "variable" keeps these apart from positional params.
        for (const v of unit.operationInfo.variables) {
          raw.parameters.push({
            name: v.name,
            position: raw.parameters.length,
            role: "variable",
            // Already prints the `!` suffix for a non-null type.
            typeText: v.type,
          });
        }
      } else if (
        matchedPattern?.bindingExtraction?.path.type === "fromFilename"
      ) {
        const binding = fileRouteBinding(
          raw.identity.file,
          unit,
          matchedPattern.bindingExtraction,
          pack,
        );
        if (binding !== null) {
          raw.boundaryBinding = binding;
        }
      } else if (unit.callSite !== undefined && matchedPattern !== undefined) {
        const binding = extractConsumerBinding(
          unit,
          matchedPattern,
          pack,
          resolution,
        );
        if (binding !== null) {
          raw.boundaryBinding = binding;
          // The summary already records the crossing, so a call whose
          // method nobody declared gets no effect at all.
          if (
            binding.semantics.name === "rest" &&
            binding.semantics.method !== null
          ) {
            const defaultBranch = raw.branches.find((b) => b.isDefault);
            if (defaultBranch !== undefined) {
              const calleeText = unit.callSite.callExpression
                .getExpression()
                .getText();
              defaultBranch.extraEffects = [
                ...(defaultBranch.extraEffects ?? []),
                {
                  type: "interaction",
                  binding,
                  callee: calleeText,
                  interaction: {
                    class: "service-call",
                    method: binding.semantics.method,
                  },
                },
              ];
            }
          }
        }
      } else if (pack.contractReading !== undefined) {
        const contract = readContract(
          unit,
          pack.contractReading,
          pack.name,
          resolution,
        );
        if (contract !== null) {
          raw.declaredContract = contract.declaredContract;
          if (contract.boundaryBinding !== null) {
            raw.boundaryBinding = contract.boundaryBinding;
          }
        }
      }

      // A route bound through routeInfo above can still declare its
      // responses on the registration call (zod-openapi's createRoute),
      // so only the declaration is read here; the binding stays.
      if (
        raw.declaredContract === null &&
        pack.contractReading?.endpoint?.from === "registrationArgument"
      ) {
        const contract = readContract(
          unit,
          pack.contractReading,
          pack.name,
          resolution,
        );
        if (contract !== null) {
          raw.declaredContract = contract.declaredContract;
        }
      }

      // Every unit ends up with a binding. A unit nothing else placed is
      // a TypeScript function with no transport of its own.
      if (raw.boundaryBinding === null) {
        if (unit.packageExportInfo !== undefined) {
          raw.boundaryBinding = packageExportBinding({
            transport: pack.protocol,
            recognition: pack.name,
            packageName: unit.packageExportInfo.packageName,
            exportPath: unit.packageExportInfo.exportPath,
          });
        } else {
          raw.boundaryBinding = functionCallBinding({
            transport: pack.protocol,
            recognition: pack.name,
            ...(unit.functionCallInfo !== undefined
              ? {
                  module: unit.functionCallInfo.module,
                  exportName: unit.functionCallInfo.exportName,
                }
              : {}),
          });
        }
      }

      const summary = assembleSummary(raw, options);
      if (options?.gapHandling !== "silent") {
        for (const stop of unfollowedStopsOf(unit, wrappers)) {
          summary.gaps.push(unfollowedCallGap(stop));
        }
      }
      if (
        unit.metadata !== undefined &&
        Object.keys(unit.metadata).length > 0
      ) {
        summary.metadata = {
          ...(summary.metadata ?? {}),
          ...unit.metadata,
        };
      }
      summaries.push(summary);
    }

    if (tally !== undefined) {
      tally.unitsDiscovered += units.length;
      tally.summariesProduced += summaries.length - summariesBefore;
      for (const unit of units) {
        const matched = unit.pattern?.match;
        if (matched?.type === "registrationTemplate") {
          tally.helpersMatched.add(matched.helperName);
        }
      }
    }
  }

  for (const tally of gatedIn) {
    tally.unitsInGatedFiles += unitsWalkedHere;
  }

  // What the module does when it loads, which is in no unit's body. Once
  // per file, because module scope belongs to the module and not to
  // whichever pack got there first.
  const moduleScope = moduleInitSummary(
    sourceFile,
    runAccessRecognizersAtModuleScope(
      sourceFile,
      allAccessRecognizers,
      resolution === undefined
        ? undefined
        : (value) => resolution.resolveWrittenValue(value),
      resolution === undefined
        ? undefined
        : (value, module) =>
            resolution.importOriginsOf(value, [module]).length > 0,
      resolution === undefined
        ? undefined
        : (value, matches) => resolution.anchorCallsOf(value, matches),
    ).map((recognized) => recognized.effect),
    options,
  );
  if (moduleScope !== null) {
    summaries.push(moduleScope);
  }

  return summaries;
}

/**
 * Point this unit at the middleware and error handlers that run around
 * it, each of which has a summary of its own saying what it does.
 *
 * The wrapper's file is recorded as a dependency because the reference
 * says what the wrapper is called there, and a rename changes this
 * summary without touching the file this walk is reading.
 */
function stampWrappers(
  raw: RawCodeStructure,
  unit: DiscoveredUnit,
  wrappers: WrapperIndex | undefined,
): void {
  if (wrappers === undefined || unit.registrationSubjectId === undefined) {
    return;
  }
  const applied = wrappers.wrappersFor(unit.registrationSubjectId);
  if (applied.length === 0) {
    return;
  }
  raw.wrappers = [...applied];
  for (const wrapper of applied) {
    recordFileDependency(wrapper.file);
  }
}

/**
 * The calls this unit is read without: its own registration when the
 * receiver would not settle, and any wrapper registered on its app
 * through a factory the store could not follow.
 */
function unfollowedStopsOf(
  unit: DiscoveredUnit,
  wrappers: WrapperIndex | undefined,
): UnfollowedCall[] {
  const stops = unit.unfollowed === undefined ? [] : [unit.unfollowed];
  if (wrappers === undefined || unit.registrationSubjectId === undefined) {
    return stops;
  }
  return [...stops, ...wrappers.unfollowedFor(unit.registrationSubjectId)];
}

/**
 * One marker summary per pack-declared library whose module some
 * project file imports. The marker's metadata says which env vars the
 * library reads from inside node_modules, where no walk looks, so the
 * runtime-config pairing can consult it before calling a declared
 * variable unused. Anchored at the first importing file found.
 */
function emitLibraryEnvReadMarkers(
  summaries: BehavioralSummary[],
  project: Project,
  frameworks: PatternPack[],
): void {
  for (const pack of frameworks) {
    for (const declared of pack.libraryEnvVars ?? []) {
      const importer = fileImporting(project, declared.module);
      if (importer === undefined) {
        continue;
      }
      summaries.push(libraryEnvReadMarker(pack, declared, importer));
    }
  }
}

function fileImporting(
  project: Project,
  modulePrefix: string,
): string | undefined {
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isInNodeModules() || sourceFile.isDeclarationFile()) {
      continue;
    }

    for (const imp of sourceFile.getImportDeclarations()) {
      if (imp.getModuleSpecifierValue().startsWith(modulePrefix)) {
        return sourceFile.getFilePath();
      }
    }
  }
  return undefined;
}

/**
 * Move each schema onto one summary standing for the document that
 * declares it, and leave every resolver pointing at that document.
 *
 * A server's `typeDefs` is one schema however many resolvers it
 * declares, and repeating it on each of them makes the artifact grow
 * with the schema times the field count. The checker reads it back
 * through the same label.
 */
function liftSchemasOntoDocuments(summaries: BehavioralSummary[]): void {
  const sdlByDocument = new Map<string, string>();
  for (const summary of summaries) {
    const label = readSourceDocumentMetadata(summary)?.label;
    const graphql = readGraphqlMetadata(summary);
    if (label === undefined || graphql?.schemaSdl === undefined) {
      continue;
    }
    sdlByDocument.set(label, graphql.schemaSdl);
    const { schemaSdl: _movedToTheDocument, ...rest } = graphql;
    summary.metadata = withGraphqlMetadata(summary.metadata, rest);
  }
  for (const [label, schemaSdl] of sdlByDocument) {
    summaries.push(schemaDocumentSummary(label, schemaSdl));
  }
}

/** Binds to no boundary: a client crosses `Query.users`, not a schema. */
function schemaDocumentSummary(
  label: string,
  schemaSdl: string,
): BehavioralSummary {
  return {
    kind: "library",
    location: { file: label, range: { start: 0, end: 0 }, exportName: null },
    identity: { name: label, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withGraphqlMetadata(
      withSourceDocumentMetadata(undefined, { label }),
      { schemaSdl },
    ),
  };
}

function libraryEnvReadMarker(
  pack: PatternPack,
  declared: { module: string; prefixes?: string[]; names?: string[] },
  importer: string,
): BehavioralSummary {
  return {
    kind: "library",
    location: { file: importer, range: { start: 0, end: 0 }, exportName: null },
    identity: {
      name: `${declared.module} env reads`,
      exportPath: null,
      boundaryBinding: functionCallBinding({
        transport: "in-process",
        recognition: pack.name,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      libraryEnvReads: {
        module: declared.module,
        ...(declared.prefixes !== undefined
          ? { prefixes: declared.prefixes }
          : {}),
        ...(declared.names !== undefined ? { names: declared.names } : {}),
      },
    },
  };
}

function internalImportsOf(project: Project, file: string): string[] {
  const sourceFile = project.getSourceFile(file);
  if (sourceFile === undefined) {
    return [];
  }
  const targets = new Set<string>();
  const record = (target: SourceFile | undefined): void => {
    if (
      target !== undefined &&
      !target.isInNodeModules() &&
      !target.isDeclarationFile()
    ) {
      targets.add(target.getFilePath());
    }
  };
  for (const imp of sourceFile.getImportDeclarations()) {
    record(imp.getModuleSpecifierSourceFile());
  }

  for (const exp of sourceFile.getExportDeclarations()) {
    record(exp.getModuleSpecifierSourceFile());
  }
  return [...targets].sort();
}

// A wrapper is a client function whose path comes from one of its own
// parameters, so the callers that pass a literal are what pin down a
// boundary. A summary synthesized for one has no caller-local branches.
interface WrapperInfo {
  summary: BehavioralSummary;
  func: FunctionRoot;
  pathParamPosition: number;
}

function expandWrapperCallers(
  summaries: BehavioralSummary[],
  project: Project,
  options?: ExtractorOptions,
  resolution?: ResolutionStore,
): BehavioralSummary[] {
  const wrappers: WrapperInfo[] = [];
  // Building the lookup walks the project's directory tree, so it waits
  // for the first summary that needs it.
  let lookup: SourceFileLookup | null = null;

  for (const s of summaries) {
    if (s.kind !== "client") {
      continue;
    }
    const binding = s.identity.boundaryBinding;
    if (
      binding === null ||
      binding.semantics.name !== "rest" ||
      binding.semantics.method === null
    ) {
      continue;
    }
    lookup ??= createSourceFileLookup(project);
    const located = findWrapperPathParam(s, lookup);
    if (located === null) {
      continue;
    }
    wrappers.push({
      summary: s,
      func: located.func,
      pathParamPosition: located.pathParamPosition,
    });
  }

  if (wrappers.length === 0) {
    return summaries;
  }

  const derived: BehavioralSummary[] = [];
  for (const wrapper of wrappers) {
    derived.push(
      ...synthesizeCallerSummaries(wrapper, project, options, resolution),
    );
  }
  return [...summaries, ...derived];
}

// One caller passing a literal is enough for the store to say what the
// parameter is, so a filled-in path does not mean the function wrote
// one. What makes it a wrapper is forwarding the parameter.
function findWrapperPathParam(
  summary: BehavioralSummary,
  lookup: SourceFileLookup,
): { func: FunctionRoot; pathParamPosition: number } | null {
  const func = lookup.functionAt(summary.location);
  if (func === null) {
    return null;
  }
  const names = func.getParameters().map((p) => p.getName());
  if (names.length === 0) {
    return null;
  }
  for (const call of func.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const first = call.getArguments()[0];
    if (first === undefined || !Node.isIdentifier(first)) {
      continue;
    }
    const at = names.indexOf(first.getText());
    if (at !== -1) {
      return { func, pathParamPosition: at };
    }
  }
  return null;
}

function synthesizeCallerSummaries(
  wrapper: WrapperInfo,
  _project: Project,
  options?: ExtractorOptions,
  resolution?: ResolutionStore,
): BehavioralSummary[] {
  const nameNode = wrapperNameNode(wrapper.func);
  if (nameNode === null) {
    return [];
  }

  const refs = nameNode.findReferencesAsNodes();
  const seen = new Set<string>();
  const out: BehavioralSummary[] = [];

  for (const ref of refs) {
    if (ref === nameNode) {
      continue;
    }
    const callExpr = enclosingCall(ref);
    if (callExpr === null) {
      continue;
    }

    const args = callExpr.getArguments();
    const pathArg = args[wrapper.pathParamPosition];
    if (pathArg === undefined) {
      continue;
    }
    const path = pathFromArgument(pathArg, resolution);
    if (path === undefined) {
      continue;
    }

    const callerFunc = enclosingFunction(callExpr);
    if (callerFunc === null) {
      continue;
    }

    const dedupKey = `${callerFunc.getStart()}:${callExpr.getStart()}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);

    out.push(buildCallerSummary(wrapper, callerFunc, callExpr, path, options));
  }

  return out;
}

function wrapperNameNode(func: FunctionRoot): Identifier | null {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    const name = func.getNameNode();
    if (name !== undefined && Node.isIdentifier(name)) {
      return name;
    }
  }
  // An arrow or function expression takes the name of the variable it is
  // assigned to.
  const parent = func.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      return nameNode;
    }
  }
  return null;
}

function enclosingCall(node: Node): CallExpression | null {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (Node.isCallExpression(current)) {
      return current;
    }
    if (Node.isPropertyAccessExpression(current)) {
      current = current.getParent();
      continue;
    }
    return null;
  }
  return null;
}

function enclosingFunction(node: Node): FunctionRoot | null {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current as FunctionRoot;
    }
    current = current.getParent();
  }
  return null;
}

function callerName(func: FunctionRoot): string {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    return func.getName() ?? "anonymous";
  }
  const parent = func.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    const nameNode = parent.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      return nameNode.getText();
    }
  }
  return "anonymous";
}

function buildCallerSummary(
  wrapper: WrapperInfo,
  callerFunc: FunctionRoot,
  callExpr: CallExpression,
  path: string,
  options?: ExtractorOptions,
): BehavioralSummary {
  const wrapperBinding = wrapper.summary.identity.boundaryBinding;
  const wrapperRest =
    wrapperBinding?.semantics.name === "rest" ? wrapperBinding.semantics : null;

  const syntheticPack: PatternPack = {
    name: wrapperBinding?.recognition ?? "unknown",
    // A placeholder: the binding built below overwrites it.
    protocol: wrapperBinding?.transport ?? "http",
    languages: ["typescript"],
    discovery: [],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
    // Empty rather than absent. The wrapper already unwrapped the
    // response, so every property a caller reads is a body field, and
    // absent would let the fallback drop `status` and `headers`.
    responseSemantics: [],
  };

  const unit: DiscoveredUnit = {
    func: callerFunc,
    kind: "client",
    name: callerName(callerFunc),
    callSite: {
      callExpression: callExpr,
      methodName: wrapper.summary.identity.name,
    },
  };

  const raw = extractCodeStructure(unit, syntheticPack);
  raw.boundaryBinding = restBinding({
    transport: wrapperBinding?.transport ?? "http",
    method: wrapperRest?.method ?? null,
    path,
    recognition: wrapperBinding?.recognition ?? "unknown",
  });

  const summary = assembleSummary(raw, options);
  summary.metadata = {
    ...(summary.metadata ?? {}),
    derivedFromWrapper: {
      file: wrapper.summary.location.file,
      name: wrapper.summary.identity.name,
    },
  };
  summary.confidence = { source: "inferred_static", level: "low" };
  return summary;
}

// A run without a settled root (a caller-supplied Project and no
// projectRoot) falls back to the summaries' common directory, which
// at least spells every id in the run from one place.
function named(
  summaries: BehavioralSummary[],
  workspace: string | undefined,
  runRoot: string | undefined,
): BehavioralSummary[] {
  const projectRoot =
    runRoot ?? commonDirectoryOf(summaries.map((s) => s.location.file));
  nameSummaries(summaries, {
    workspace: workspace ?? workspaceNameFor(projectRoot),
    projectRoot,
  });
  return summaries;
}

export interface TypeScriptAdapterConfig {
  tsConfigFilePath?: string;
  /**
   * Absolute. Every id's file path is relative to this directory. When
   * absent, settled by workspaceRootFor from the tsconfig's directory.
   */
  projectRoot?: string;
  /** Separates two services in one repository whose file names match. */
  workspace?: string;
  project?: Project;
  frameworks: PatternPack[];
  extractorOptions?: ExtractorOptions;
  /** A `library` summary per function reachable by a static call edge. */
  includeReachable?: boolean;
  onTiming?: (report: TimingReport) => void;
  onCacheDiagnostic?: (diagnostic: CacheDiagnostic) => void;
  /** Not called on a cache hit, where no stage ran. */
  onExtractionReport?: (report: ExtractionReport) => void;
  /** Absolute. `.suss/cache/` beside the tsconfig; `null` turns it off. */
  cacheDir?: string | null;
}

export interface TypeScriptAdapter extends LanguageAdapter {
  /** Kept off `LanguageAdapter`, so a caller needing ts-morph asks for it. */
  readonly tsProject: Project;
  extractFromFiles(filePaths: string[]): Promise<BehavioralSummary[]>;
  extractAll(): Promise<BehavioralSummary[]>;
}

/** Anything that changes what an extraction produces belongs in the key. */
export function extractionConfigStamp(config: {
  includeReachable?: boolean;
  extractorOptions?: { gapHandling?: string };
}): string {
  return [
    `includeReachable=${config.includeReachable !== false}`,
    `gapHandling=${config.extractorOptions?.gapHandling ?? "default"}`,
  ].join(",");
}

/**
 * Fix the walked-file list, then load the import graph under it. On a
 * gated run the candidates are not in the project yet, and the load
 * pass inserts each file after everything it imports with the
 * candidates last, so the compiler's program build never descends a
 * whole re-export chain from its top (#211). The walked list is the
 * candidates either way; the files loaded under them are reachable,
 * never walked for units.
 */
function loadRunFiles(
  project: Project,
  candidatePaths: string[] | null,
  timer: Timer,
): { sourceFiles: SourceFile[]; deep: DeepImportGraphs } {
  if (candidatePaths !== null) {
    const deep = timer.time("loadImportGraphs", () =>
      loadImportGraphsDepthFirstFromPaths(project, candidatePaths),
    );
    const sourceFiles = timer.time("project.getSourceFiles", () =>
      candidatePaths.flatMap((p) => {
        const sf = project.getSourceFile(p);
        return sf !== undefined && !sf.isDeclarationFile() ? [sf] : [];
      }),
    );
    return { sourceFiles, deep };
  }

  // One enumeration, reused by every phase, since per-phase calls
  // dominate on a large monorepo. The load pass runs after the list is
  // taken, so the run walks the same files it would have without it.
  const sourceFiles = timer.time("project.getSourceFiles", () =>
    project.getSourceFiles().filter((sf) => !sf.isDeclarationFile()),
  );
  const deep = timer.time("loadImportGraphs", () =>
    loadImportGraphsDepthFirst(sourceFiles),
  );
  return { sourceFiles, deep };
}

/** What this adapter stores in a cached file's opaque `meta` slot. */
interface TsCacheMeta {
  /** Mount prefixes the walk consumed, by mounted router node id. */
  mountPrefixes: Record<string, string>;
}

export function createTypeScriptAdapter(
  suppliedConfig: TypeScriptAdapterConfig,
): TypeScriptAdapter {
  // Workspace-marked patterns become concrete per-package ones before
  // anything else reads the pack list.
  const config: TypeScriptAdapterConfig = {
    ...suppliedConfig,
    frameworks: expandWorkspacePatterns(
      suppliedConfig.frameworks,
      suppliedConfig.projectRoot ??
        (suppliedConfig.tsConfigFilePath !== undefined
          ? path.dirname(suppliedConfig.tsConfigFilePath)
          : undefined),
    ),
  };

  const project =
    config.project ??
    new Project(
      config.tsConfigFilePath !== undefined
        ? {
            tsConfigFilePath: config.tsConfigFilePath,
            skipAddingFilesFromTsConfig: true,
          }
        : { skipAddingFilesFromTsConfig: true },
    );

  // Settled once, before any file loads, so a cached run and a cold
  // run of the same command measure their ids from the same directory.
  const runRoot =
    config.projectRoot ??
    (config.tsConfigFilePath !== undefined
      ? workspaceRootFor(path.dirname(config.tsConfigFilePath))
      : undefined);

  let lazyBootstrapped = false;
  // The whole tsconfig include set, which bounds what closure expansion
  // may lazy-add, so a run never pulls in `node_modules`.
  let projectFileSet: ReadonlySet<string> | undefined;

  // A caller-supplied Project gets no disk cache by default: the stat
  // check against in-memory paths would always miss.
  const cacheDir = declineWhenRunFromSource(
    config.cacheDir === null
      ? null
      : (config.cacheDir ??
          (config.tsConfigFilePath !== undefined
            ? path.join(path.dirname(config.tsConfigFilePath), ".suss", "cache")
            : null)),
  );
  const cache: CacheLayer<TsCacheMeta> =
    createCacheLayer<TsCacheMeta>(cacheDir);
  const packsDigest = `${computeAdapterPacksDigest(
    config.frameworks.map((p) =>
      p.version !== undefined
        ? { name: p.name, version: p.version }
        : { name: p.name },
    ),
  )}|${extractionConfigStamp(config)}|ws:${workspaceExpansionStamp(config.frameworks)}`;

  const packWrappers = config.frameworks.flatMap(
    (pack) => pack.transparentWrappers ?? [],
  );

  return {
    tsProject: project,

    async extractFromFiles(filePaths: string[]): Promise<BehavioralSummary[]> {
      const summaries: BehavioralSummary[] = [];
      const resolution = new ResolutionStore(packWrappers);
      const claimedUnits = new Map<string, ClaimedUnit>();

      for (const fp of filePaths) {
        // The caller asked for this file by name, so load it whatever the
        // gate would have decided.
        let sourceFile = project.getSourceFile(fp);
        if (sourceFile === undefined) {
          try {
            sourceFile = project.addSourceFileAtPath(fp);
          } catch {
            continue;
          }
        }
        summaries.push(
          ...extractFromSourceFile(
            sourceFile,
            config.frameworks,
            claimedUnits,
            config.extractorOptions,
            undefined,
            resolution,
          ),
        );
      }

      return named(summaries, config.workspace, runRoot);
    },

    async extractAll(): Promise<BehavioralSummary[]> {
      const timer = createTimer();
      const tallies = createPackTallies(config.frameworks);
      // Clear the record first: what this run could not read is what
      // this run reports.
      forgetUnreadableExportFiles();
      forgetReassignedNamesUnstated();

      // Read before bootstrap so the cache check below can run against
      // it, and a hit costs no parsing.
      const lazyEligible =
        !lazyBootstrapped &&
        config.tsConfigFilePath !== undefined &&
        config.project === undefined;
      const tsconfigFileList = lazyEligible
        ? timer.time("readTsconfigFileList", () =>
            readTsconfigFileList(
              config.tsConfigFilePath ??
                raise("lazy bootstrap requires tsConfigFilePath"),
            ),
          )
        : null;

      // Nothing reads the digest or the file list when the run is not
      // caching, and settling either walks the tree for every template
      // a pack reads.
      let cacheFiles: string[] | null = null;
      const adapterPacksDigest =
        cacheDir === null
          ? packsDigest
          : timer.time("cache.digest", () => {
              cacheFiles =
                tsconfigFileList ??
                project.getSourceFiles().map((sf) => sf.getFilePath());
              return runDigest(packsDigest, config.frameworks, cacheFiles);
            });

      const cacheInput: CacheInput = {
        // Empty when cacheDir is null: a no-op cache layer never reads
        // the file list, so there is nothing worth resolving early.
        files: cacheFiles ?? [],
        adapterPacksDigest,
        ...(config.tsConfigFilePath !== undefined
          ? { configPath: config.tsConfigFilePath }
          : {}),
      };
      const lookup = await timer.timeAsync("cache.lookup", () =>
        cache.lookup(cacheInput),
      );
      if (config.onCacheDiagnostic !== undefined) {
        config.onCacheDiagnostic(lookup.diagnostic);
      }
      if (lookup.kind === "hit") {
        if (config.onTiming !== undefined) {
          config.onTiming(timer.report());
        }
        return named(lookup.summaries, config.workspace, runRoot);
      }

      // A files-changed miss can still reuse per file, when the entry
      // recorded which file each summary came from.
      const plan =
        lookup.diagnostic.missReason === "files-changed"
          ? await timer.timeAsync("cache.plan", () => cache.plan(cacheInput))
          : null;
      if (plan !== null && plan.changed.size === 0 && plan.removed.size === 0) {
        // Stamps moved but every content hash matched: a touch, not an
        // edit. Refresh the stamps so the next run hits on stats alone.
        try {
          await cache.write(
            cacheInput,
            plan.allSummaries(),
            plan.attribution(),
          );
        } catch {
          // A failed refresh costs the next run a rehash, nothing more.
        }
        if (config.onCacheDiagnostic !== undefined) {
          config.onCacheDiagnostic({ kind: "hit" });
        }
        if (config.onTiming !== undefined) {
          config.onTiming(timer.report());
        }
        return named(plan.allSummaries(), config.workspace, runRoot);
      }

      let candidatePaths: string[] | null = null;
      if (lazyEligible) {
        const lazy = await timer.timeAsync("lazyProjectInit", () =>
          createLazyProject(
            config.tsConfigFilePath ??
              raise("lazy bootstrap requires tsConfigFilePath"),
            config.frameworks,
          ),
        );
        candidatePaths = lazy.candidatePaths;
        projectFileSet = lazy.projectFileSet;
        lazyBootstrapped = true;
      }

      const summaries: BehavioralSummary[] = [];

      const { sourceFiles, deep } = loadRunFiles(
        project,
        candidatePaths,
        timer,
      );
      timer.time("warmExportChains", () => warmExportChains(deep.deepRoots));

      const resolution = new ResolutionStore(packWrappers);
      const packsByFile = timer.time("preFilter", () =>
        computePackApplicability(sourceFiles, config.frameworks, resolution),
      );

      // An app built in one file and registered on in another is joined
      // by facts in the file that passed it, which no query reaches.
      timer.time("registeringFiles", () =>
        readRegisteringFiles(packsByFile, resolution),
      );

      // A route on a mounted router needs the mount's prefix folded into
      // its path before the walk below builds its binding.
      const mountPrefixes = timer.time("mountPrefix", () =>
        buildMountPrefixIndex(packsByFile, resolution),
      );

      // A route's own body is not all of its wire behaviour, so the
      // middleware and error handlers registered on the same app get
      // summarized too, and the route points at them.
      const wrappers = timer.time("wrapperIndex", () =>
        buildWrapperIndex(packsByFile, resolution, mountPrefixes),
      );

      // A helper the project wrote in front of a library is read once
      // here, so the pack's own matchers run at the call site instead.
      const projectHelpers = timer.time("helperIndex", () =>
        buildProjectHelperIndex(
          sourceFiles,
          config.frameworks,
          packsByFile,
          resolution,
        ),
      );

      const caching = cacheDir !== null;

      // Which stored files survive: their own hash and their recorded
      // dependencies unchanged, every consumed mount prefix resolving
      // the same against this run's index, and the same packs applying.
      const validRoots = new Set<string>();
      if (plan !== null) {
        const packNamesByPath = new Map<string, string>();
        for (const [sf, packs] of packsByFile) {
          packNamesByPath.set(
            sf.getFilePath(),
            packs
              .map((p) => p.name)
              .sort()
              .join(","),
          );
        }
        for (const rootPath of plan.validRoots) {
          const record = plan.roots.get(rootPath);
          if (record === undefined) {
            continue;
          }
          if (!mountAssumptionsAgree(record, mountPrefixes)) {
            continue;
          }
          const stored = [...record.packs].sort().join(",");
          if ((packNamesByPath.get(rootPath) ?? "") !== stored) {
            continue;
          }
          validRoots.add(rootPath);
        }
      }
      const reused =
        plan !== null && validRoots.size > 0 ? plan.reuse(validRoots) : null;

      const claimedUnits = new Map<string, ClaimedUnit>();
      if (reused !== null && plan !== null) {
        // Replay the claims the reused walks made, so a re-walked file
        // skips the units a reused file's walk already owns.
        for (const rootPath of validRoots) {
          for (const claim of plan.roots.get(rootPath)?.claims ?? []) {
            claimedUnits.set(claim.key, { pack: claim.pack, file: rootPath });
          }
        }
      }

      const walkList =
        reused === null
          ? sourceFiles
          : sourceFiles.filter((sf) => !validRoots.has(sf.getFilePath()));

      const sinkByRoot = new Map<string, DependencySink>();
      const ownersBySummary = new Map<BehavioralSummary, Set<string>>();
      timer.time("extract per-file", () => {
        for (const sourceFile of walkList) {
          const rootPath = sourceFile.getFilePath();
          const sink = createDependencySink();
          if (caching) {
            // Recorded even for a gated-out file: an empty record still
            // says the walk read nothing beyond the file itself.
            sinkByRoot.set(rootPath, sink);
          }
          const applicablePacks = packsByFile.get(sourceFile);
          if (applicablePacks === undefined) {
            continue;
          }
          // A module graph too deep for the checker takes the stack down
          // with it. Reporting the one file costs less than the run.
          try {
            const walked = withDependencySink(sink, () => {
              for (const helperFile of projectHelpers.helperFilesFor(
                sourceFile,
              )) {
                recordFileDependency(helperFile);
              }
              return extractFromSourceFile(
                sourceFile,
                applicablePacks,
                claimedUnits,
                config.extractorOptions,
                tallies,
                resolution,
                mountPrefixes,
                wrappers,
                projectHelpers,
              );
            });
            for (const summary of walked) {
              ownersBySummary.set(summary, new Set([rootPath]));
            }
            summaries.push(...walked);
          } catch (error) {
            if (!(error instanceof RangeError)) {
              throw error;
            }
            noteUnreadableExports(sourceFile);
          }
        }
      });

      // Reused wrapper summaries still seed caller expansion: derived
      // callers are recomputed every run rather than cached, so a new
      // caller in an edited file is found either way.
      const wrapperInput =
        reused === null ? summaries : [...summaries, ...reused.summaries];
      const withWrappers = timer.time("expandWrapperCallers", () =>
        expandWrapperCallers(
          wrapperInput,
          project,
          config.extractorOptions,
          resolution,
        ),
      );
      const pipeline =
        reused === null
          ? withWrappers
          : [...summaries, ...withWrappers.slice(wrapperInput.length)];
      const withSubUnits = timer.time("synthesizeSubUnits", () =>
        synthesizeSubUnits(
          pipeline,
          project,
          config.frameworks,
          packsByFile,
          config.extractorOptions,
          tallies,
          (created, parent) => {
            const parentOwners = ownersBySummary.get(parent);
            if (parentOwners !== undefined) {
              ownersBySummary.set(created, new Set(parentOwners));
            }
          },
        ),
      );
      // Closure needs `projectFileSet` to lazy-add a callee's file as it
      // walks in: symbol resolution alone loads it into the program but
      // leaves it off `getSourceFiles`, which the rethrow lookup uses.
      const closureFacts: ClosureFacts = {
        db: new Database(),
        unitKeyBySummary: new Map(),
        ...(caching ? { filesByKey: new Map<string, Set<string>>() } : {}),
      };
      const withClosure =
        config.includeReachable !== false
          ? timer.time("expandReachableClosure", () =>
              expandReachableClosure(
                withSubUnits,
                project,
                config.extractorOptions,
                projectFileSet,
                closureFacts,
                {
                  invocation: [
                    ...collectInvocationRecognizers(config.frameworks, tallies),
                    ...projectHelpers.contributedRecognizers(),
                  ],
                  access: collectAccessRecognizers(config.frameworks, tallies),
                  resolution,
                  resolveCallableSources: (value, alsoFrom) =>
                    resolution.resolveCallableSources(value, alsoFrom),
                  sourceDeclarationsBehind: (declaration) =>
                    sourceDeclarationsBehind(declaration, resolution),
                },
                // Reached units the cache already serves emit nothing,
                // the way a cold run's seeds do not.
                reused?.summaries ?? [],
                // A recognizer-only pack's effects need a function to
                // live on even when nothing discovers units in its
                // files, so those files' exports join the walk as
                // roots.
                recognizerOnlyRoots(packsByFile),
              ),
            )
          : withSubUnits;

      // Attribute each reached library summary to the walked files
      // whose seeds reach it, before merge decides what survives.
      const closureOwnership =
        caching && config.includeReachable !== false
          ? timer.time("cache.attributeClosure", () =>
              attributeReachedSummaries(
                withSubUnits,
                withClosure.slice(withSubUnits.length),
                closureFacts,
                ownersBySummary,
              ),
            )
          : null;

      // The passes below read across the whole summary set, so reused
      // summaries join before them. What they recompute on a reused
      // summary is the same function of the same unchanged subtree.
      const merged = timer.time("cache.merge", () =>
        mergeWithReused(reused, withClosure, ownersBySummary),
      );

      // Runs after the closure, so that every callee's throw terminals
      // exist to read a rethrow's possible sources from.
      const enriched = timer.time("enrichRethrows", () =>
        enrichRethrows(merged.summaries, project, closureFacts),
      );

      if (config.includeReachable !== false) {
        timer.time("deriveBoundaryEffects", () =>
          deriveBoundaryEffects(enriched, closureFacts),
        );
      }

      // Absolute paths here; the CLI makes them relative beside `location.file`.
      // A leaf file stays unstamped, as it always has for TypeScript.
      timer.time("stampModuleImports", () =>
        stampModuleImports(enriched, (file) => {
          const imports = internalImportsOf(project, file);
          return imports.length === 0 ? undefined : imports;
        }),
      );
      timer.time("emitLibraryEnvReadMarkers", () =>
        emitLibraryEnvReadMarkers(enriched, project, config.frameworks),
      );
      timer.time("liftSchemasOntoDocuments", () =>
        liftSchemasOntoDocuments(enriched),
      );
      timer.time("stampGraphqlClientRefs", () =>
        stampGraphqlClientRefs(
          enriched,
          sourceFiles,
          config.frameworks,
          resolution,
        ),
      );

      if (config.onCacheDiagnostic !== undefined && plan !== null) {
        config.onCacheDiagnostic({
          kind: "partial",
          partial: {
            filesChanged: plan.changed.size,
            filesRemoved: plan.removed.size,
            rootsReused: validRoots.size,
            rootsReextracted: walkList.length,
            rootsDeclined: plan.rootsDeclined,
            summariesReused: merged.reusedKept.length,
          },
        });
      }

      await timer.timeAsync("cache.write", async () => {
        // An empty result is never cached. Serving one would skip the
        // stages that fill the funnel, so a misconfigured project would
        // get "0 summaries" with no explanation ever after.
        if (!caching || enriched.length === 0) {
          return;
        }
        try {
          const attribution = buildCacheAttribution({
            project,
            plan,
            validRoots,
            sinkByRoot,
            ownersBySummary,
            closureOwnership,
            unitKeyBySummary: closureFacts.unitKeyBySummary,
            filesByKey: closureFacts.filesByKey,
            packsByFile,
            reusedKept: merged.reusedKept,
            reusedOwners: merged.reusedOwners,
            // Everything after the reused prefix, the passes' own
            // additions (markers, schema documents) included.
            fresh: enriched.slice(merged.reusedKept.length),
          });
          await cache.write(cacheInput, enriched, attribution);
        } catch {
          // A failed cache write must not fail the extract.
        }
      });

      // After the cache write, because what a route's wrappers do is a
      // function of the whole run and a stored summary of the route
      // alone stays reusable.
      const composed = timer.time("composeWrappers", () =>
        composeWrappers(enriched),
      );

      if (config.onTiming !== undefined) {
        config.onTiming(timer.report());
      }

      if (config.onExtractionReport !== undefined) {
        config.onExtractionReport(
          buildExtractionReport({
            packs: config.frameworks,
            tallies,
            filesInProject: tsconfigFileList?.length ?? null,
            filesWalked: walkList.length,
            summaries: composed,
            tsConfigFilePath: config.tsConfigFilePath,
            projectRoot: commonDirectoryOf(
              sourceFiles.map((f) => f.getFilePath()),
            ),
            filesWithUnreadableExports: unreadableExportFiles(),
            reassignedNamesUnstated: reassignedNamesUnstated(),
            contributedPatterns: (packName) =>
              projectHelpers.patternsFor(packName),
          }),
        );
      }

      // Naming runs last, so a call can point at anything the run
      // produced.
      return named(
        composed,
        config.workspace,
        runRoot ?? commonDirectoryOf(sourceFiles.map((f) => f.getFilePath())),
      );
    },
  };
}

/**
 * Whether every mount prefix a stored walk consumed still resolves to
 * the same value against this run's index. A mount added, removed or
 * changed lands here, because the consuming file's own content never
 * mentions it and no recorded dependency would catch it.
 */
function mountAssumptionsAgree(
  record: RootRecord<TsCacheMeta>,
  index: MountPrefixIndex,
): boolean {
  return Object.entries(record.meta.mountPrefixes).every(
    ([childId, prefix]) => (index.prefixForId?.(childId) ?? "") === prefix,
  );
}

/**
 * Give each closure-reached summary the owners of every walked file
 * whose seeds reach its function, and return the reachable key set per
 * walked file for dependency recording. A helper two files share ends
 * up owned by both, so either file's reuse keeps it alive.
 */
interface ClosureOwnership {
  /** Reachable unit keys per walked file, for dependency recording. */
  reachableByRoot: Map<string, Set<string>>;
  /** Walked files reaching each unit key, for reused-owner updates. */
  rootsByKey: Map<string, Set<string>>;
}

function attributeReachedSummaries(
  seeds: BehavioralSummary[],
  reached: BehavioralSummary[],
  facts: ClosureFacts,
  owners: Map<BehavioralSummary, Set<string>>,
): ClosureOwnership {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of facts.db.facts("calls")) {
    const key = String(from);
    const bucket = adjacency.get(key) ?? [];
    bucket.push(String(to));
    adjacency.set(key, bucket);
  }

  const seedKeysByRoot = new Map<string, string[]>();
  for (const seed of seeds) {
    const key = facts.unitKeyBySummary.get(seed);
    if (key === undefined) {
      continue;
    }
    for (const root of owners.get(seed) ?? []) {
      const bucket = seedKeysByRoot.get(root) ?? [];
      bucket.push(key);
      seedKeysByRoot.set(root, bucket);
    }
  }

  const reachableByRoot = new Map<string, Set<string>>();
  const rootsByKey = new Map<string, Set<string>>();
  for (const [root, seedKeys] of seedKeysByRoot) {
    const seen = new Set<string>(seedKeys);
    const queue = [...seedKeys];
    while (queue.length > 0) {
      const key = queue.pop();
      if (key === undefined) {
        continue;
      }
      for (const next of adjacency.get(key) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
      const keyRoots = rootsByKey.get(key) ?? new Set<string>();
      keyRoots.add(root);
      rootsByKey.set(key, keyRoots);
    }
    reachableByRoot.set(root, seen);
  }

  for (const summary of reached) {
    const key = facts.unitKeyBySummary.get(summary);
    if (key === undefined) {
      continue;
    }
    const keyRoots = rootsByKey.get(key);
    if (keyRoots !== undefined && keyRoots.size > 0) {
      owners.set(summary, new Set(keyRoots));
    }
  }
  return { reachableByRoot, rootsByKey };
}

/**
 * A unit key is `file:start-end`; everything before the last colon is
 * the file. Null for a key with no colon, which no walk produces.
 */
function fileOfNodeKey(key: string): string | null {
  const cut = key.lastIndexOf(":");
  return cut <= 0 ? null : key.slice(0, cut);
}

/**
 * The unit a summary describes, spelled from fields that survive the
 * round trip through the manifest. Two runs over an unchanged file
 * spell the same unit the same way, which is what merge dedup needs.
 */
function summaryMergeKey(summary: BehavioralSummary): string {
  return JSON.stringify([
    summary.location.file,
    summary.location.range.start,
    summary.location.range.end,
    summary.kind,
    summary.identity.name,
    summary.identity.exportPath,
    summary.identity.boundaryBinding,
  ]);
}

/**
 * Combine reused summaries with this run's. A fresh copy supersedes a
 * reused one for the same unit (a shared helper reached from both a
 * reused and a re-walked file), and the reused copy's owners fold into
 * the fresh one so the other file's later edits keep it alive.
 */
function mergeWithReused(
  reused: { summaries: BehavioralSummary[]; owners: string[][] } | null,
  fresh: BehavioralSummary[],
  ownersBySummary: Map<BehavioralSummary, Set<string>>,
): {
  summaries: BehavioralSummary[];
  reusedKept: BehavioralSummary[];
  reusedOwners: string[][];
} {
  if (reused === null) {
    return { summaries: fresh, reusedKept: [], reusedOwners: [] };
  }
  const freshByKey = new Map<string, BehavioralSummary>();
  for (const summary of fresh) {
    freshByKey.set(summaryMergeKey(summary), summary);
  }
  const reusedKept: BehavioralSummary[] = [];
  const reusedOwners: string[][] = [];
  reused.summaries.forEach((summary, i) => {
    const owners = reused.owners[i] ?? [];
    const supersededBy = freshByKey.get(summaryMergeKey(summary));
    if (supersededBy !== undefined) {
      const freshOwners =
        ownersBySummary.get(supersededBy) ?? new Set<string>();
      for (const owner of owners) {
        freshOwners.add(owner);
      }
      ownersBySummary.set(supersededBy, freshOwners);
      return;
    }
    reusedKept.push(summary);
    reusedOwners.push(owners);
  });
  return { summaries: [...reusedKept, ...fresh], reusedKept, reusedOwners };
}

/**
 * Whether a summary's content comes partly from run-level joins the
 * cache does not model per file. Two joins exist: schema lifting moves
 * SDL between summaries sharing a document label, and client stamping
 * writes the project-wide sole client onto every operation. A file
 * that produced a joined summary is re-extracted on every partial run
 * rather than served stale. A code-first resolver joins with nothing,
 * so it stays cacheable.
 */
function readsRunLevelJoins(summary: BehavioralSummary): boolean {
  if (readSourceDocumentMetadata(summary) !== undefined) {
    return true;
  }
  if (readGraphqlMetadata(summary)?.client !== undefined) {
    return true;
  }
  const semantics = summary.identity.boundaryBinding?.semantics;
  return semantics !== undefined && "operationType" in semantics;
}

/**
 * The per-file record a write stores: which files were walked, what
 * each walk read, which summaries each file owns. Reused files keep
 * their stored records verbatim; re-walked files get fresh ones from
 * their sinks, the reference closure and the reachable set.
 */
function buildCacheAttribution(args: {
  project: Project;
  plan: PartialPlan<TsCacheMeta> | null;
  validRoots: Set<string>;
  sinkByRoot: Map<string, DependencySink>;
  ownersBySummary: Map<BehavioralSummary, Set<string>>;
  closureOwnership: ClosureOwnership | null;
  unitKeyBySummary: Map<BehavioralSummary, string>;
  filesByKey: Map<string, Set<string>> | undefined;
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>;
  reusedKept: BehavioralSummary[];
  reusedOwners: string[][];
  fresh: BehavioralSummary[];
}): CacheAttribution<TsCacheMeta> {
  const references = createReferenceIndex(
    args.project.getSourceFiles().filter((sf) => !sf.isDeclarationFile()),
  );
  const packNamesByPath = new Map<string, string[]>();
  for (const [sf, packs] of args.packsByFile) {
    packNamesByPath.set(
      sf.getFilePath(),
      packs.map((p) => p.name),
    );
  }

  const summariesByRoot = new Map<string, BehavioralSummary[]>();
  for (const summary of args.fresh) {
    for (const root of args.ownersBySummary.get(summary) ?? []) {
      const bucket = summariesByRoot.get(root) ?? [];
      bucket.push(summary);
      summariesByRoot.set(root, bucket);
    }
  }

  const roots: RootRecord<TsCacheMeta>[] = [];
  for (const [rootPath, sink] of args.sinkByRoot) {
    // Direct references only: deeper reads arrive through the sink,
    // the claims and the reachable set, so an edit far up a barrel
    // chain does not invalidate every file below it.
    const deps = new Set<string>(sink.files);
    for (const dep of references.directOf(rootPath)) {
      deps.add(dep);
    }
    let cacheable = true;
    for (const summary of summariesByRoot.get(rootPath) ?? []) {
      deps.add(summary.location.file);
      if (readsRunLevelJoins(summary)) {
        cacheable = false;
      }
    }
    const reachable =
      args.closureOwnership?.reachableByRoot.get(rootPath) ?? [];
    for (const key of reachable) {
      const keyFile = fileOfNodeKey(key);
      if (keyFile !== null) {
        deps.add(keyFile);
        // One hop past a reached file covers the types and helpers its
        // body reads without pulling in its whole import closure.
        for (const hop of references.directOf(keyFile)) {
          deps.add(hop);
        }
      }
      for (const filePath of args.filesByKey?.get(key) ?? []) {
        deps.add(filePath);
      }
    }
    deps.delete(rootPath);
    roots.push({
      path: rootPath,
      cacheable,
      deps: [...deps].sort(),
      claims: sink.claims,
      meta: { mountPrefixes: Object.fromEntries(sink.mountPrefixes) },
      packs: packNamesByPath.get(rootPath) ?? [],
    });
  }

  if (args.plan !== null) {
    for (const rootPath of args.validRoots) {
      const record = args.plan.roots.get(rootPath);
      if (record !== undefined) {
        roots.push(record);
      }
    }
  }

  // A reused summary a fresh walk also reaches gains the fresh owners,
  // so a later edit to either side still re-extracts or serves it.
  const reusedOwners = args.reusedKept.map((summary, i) => {
    const combined = new Set(args.reusedOwners[i] ?? []);
    const key = args.unitKeyBySummary.get(summary);
    if (key !== undefined) {
      for (const root of args.closureOwnership?.rootsByKey.get(key) ?? []) {
        combined.add(root);
      }
    }
    return [...combined];
  });

  const owners: string[][] = [
    ...reusedOwners,
    ...args.fresh.map((s) => [...(args.ownersBySummary.get(s) ?? [])]),
  ];
  return { roots, owners };
}

// One summary per callback a framework's runtime schedules out of a
// single source construct, such as a React component's event handlers.
// A pack picks them out through its `subUnits` hook.
function synthesizeSubUnits(
  summaries: BehavioralSummary[],
  project: Project,
  frameworks: PatternPack[],
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>,
  options?: ExtractorOptions,
  tallies?: Map<string, PackTally>,
  onCreated?: (created: BehavioralSummary, parent: BehavioralSummary) => void,
): BehavioralSummary[] {
  const packByRecognition = new Map<string, PatternPack>();
  for (const pack of frameworks) {
    packByRecognition.set(pack.name, pack);
  }
  // `summary.location.file` is absolute until the CLI relativizes it
  // after extractAll, so the applicability map keys line up.
  const packsByPath = new Map<string, readonly PatternPack[]>();
  for (const [sf, packs] of packsByFile) {
    packsByPath.set(sf.getFilePath(), packs);
  }
  const allInvocationRecognizers = collectInvocationRecognizers(
    frameworks,
    tallies,
  );
  const allAccessRecognizers = collectAccessRecognizers(frameworks, tallies);

  const synthesized: BehavioralSummary[] = [];
  const subUnitCtx = createTsSubUnitContext();
  let lookup: SourceFileLookup | null = null;

  for (const parent of summaries) {
    const binding = parent.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    // Every applicable pack contributes, the discovering pack first so
    // a name collision keeps the claimant's sub-unit, the same
    // precedence unit claims follow. A parent in a file the map does
    // not know (a wrapper-synthesized one) keeps the discovering pack.
    const discovering = packByRecognition.get(binding.recognition);
    const applicable =
      packsByPath.get(parent.location.file) ??
      (discovering !== undefined ? [discovering] : []);
    const hooked = [
      ...(discovering?.subUnits !== undefined ? [discovering] : []),
      ...applicable.filter(
        (one) => one.subUnits !== undefined && one !== discovering,
      ),
    ];
    if (hooked.length === 0) {
      continue;
    }

    lookup ??= createSourceFileLookup(project);
    const parentFunc = lookup.functionAt(parent.location);
    if (parentFunc === null) {
      continue;
    }

    const parentHandle: DiscoveredSubUnitParent = {
      func: parentFunc,
      name: parent.identity.name,
      kind: parent.kind,
    };

    const claimedFuncs = new Set<unknown>();
    const subUnits: DiscoveredSubUnit[] = [];
    for (const pack of hooked) {
      for (const subUnit of pack.subUnits?.(parentHandle, subUnitCtx) ?? []) {
        if (claimedFuncs.has(subUnit.func)) {
          continue;
        }
        claimedFuncs.add(subUnit.func);
        subUnits.push(subUnit);
      }
    }

    for (const subUnit of subUnits) {
      const summary = buildSubUnitSummary(
        subUnit,
        parent,
        allInvocationRecognizers,
        allAccessRecognizers,
        options,
      );
      if (summary !== null) {
        synthesized.push(summary);
        onCreated?.(summary, parent);
      }
    }
  }

  return [...summaries, ...synthesized];
}

const DEFAULT_SUB_UNIT_TERMINALS: TerminalPattern[] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  FUNCTION_FALLTHROUGH_TERMINAL,
];

const DEFAULT_SUB_UNIT_INPUT_MAPPING: InputMappingPattern = {
  type: "positionalParams",
  params: [],
};

function buildSubUnitSummary(
  subUnit: DiscoveredSubUnit,
  parent: BehavioralSummary,
  invocationRecognizers: InvocationRecognizer[],
  accessRecognizers: AccessRecognizer[],
  options?: ExtractorOptions,
): BehavioralSummary | null {
  const func = subUnit.func as FunctionRoot;

  // Never ships in a framework list; it parameterises this one body.
  const scaffoldPack: PatternPack = {
    name: "sub-unit",
    // A placeholder the parent's binding below overwrites. The name is
    // chosen not to collide with any shipped pack.
    protocol: "sub-unit-scaffold",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: subUnit.terminals ?? DEFAULT_SUB_UNIT_TERMINALS,
    inputMapping: subUnit.inputMapping ?? DEFAULT_SUB_UNIT_INPUT_MAPPING,
  };

  const unit: DiscoveredUnit = {
    func,
    kind: subUnit.kind,
    name: subUnit.name,
  };

  const raw = extractCodeStructure(
    unit,
    scaffoldPack,
    invocationRecognizers,
    accessRecognizers,
  );

  // A sub-unit runs on the parent's runtime, so it takes the parent's
  // binding whole and a pack never redeclares identity for one.
  if (parent.identity.boundaryBinding !== null) {
    raw.boundaryBinding = parent.identity.boundaryBinding;
  }

  const summary = assembleSummary(raw, options);
  if (
    subUnit.metadata !== undefined &&
    Object.keys(subUnit.metadata).length > 0
  ) {
    summary.metadata = {
      ...(summary.metadata ?? {}),
      ...subUnit.metadata,
    };
  }
  summary.confidence = { source: "inferred_static", level: "medium" };
  return summary;
}
