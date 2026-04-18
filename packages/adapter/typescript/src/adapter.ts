// adapter.ts — Full adapter orchestration (Task 2.5b)
//
// Wires together: discovery → extractCodeStructure → readContract → assembleSummary

import {
  type CallExpression,
  type Identifier,
  Node,
  Project,
  type SourceFile,
} from "ts-morph";

import {
  assembleSummary,
  type BindingExtraction,
  type DiscoveryPattern,
  type ExtractorOptions,
  type InputMappingPattern,
  type PatternPack,
  type RawBranch,
  type RawCodeStructure,
  type RawDependencyCall,
  type RawParameter,
  type ResponsePropertyMapping,
} from "@suss/extractor";

import { extractRawBranches } from "./assembly.js";
import { readContract, readContractForClientCall } from "./contract.js";
import { type DiscoveredUnit, discoverUnits } from "./discovery.js";
import { collectClientFieldAccesses } from "./field-accesses.js";

import type {
  BehavioralSummary,
  CodeUnitKind,
  Predicate,
  ValueRef,
} from "@suss/behavioral-ir";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

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
  } else if (inputMapping.type === "singleObjectParam") {
    const param = params[inputMapping.paramPosition];
    if (param !== undefined) {
      result.push({
        name: param.getName(),
        position: inputMapping.paramPosition,
        role: "request",
        typeText: null,
      });
    }
  } else if (inputMapping.type === "destructuredObject") {
    const param = params[0];
    if (param !== undefined) {
      const nameNode = param.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
          const name = element.getName();
          const role = inputMapping.knownProperties[name] ?? name;
          result.push({ name, position: 0, role, typeText: null });
        }
      } else {
        // Non-destructured: treat as a single object parameter
        result.push({
          name: param.getName(),
          position: 0,
          role: "request",
          typeText: null,
        });
      }
    }
  } else if (inputMapping.type === "componentProps") {
    const param = params[inputMapping.paramPosition];
    if (param !== undefined) {
      const nameNode = param.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        // Destructured props: emit one Input per bound name. The role
        // is the prop name itself — the pack doesn't know the name
        // space in advance, so the role is just "whatever the
        // component author called this prop." `typeText` comes from
        // the type of the element's binding identifier, which the
        // type checker resolves via indexing into the parameter's
        // type annotation (whether declared inline or via a named
        // interface).
        for (const element of nameNode.getElements()) {
          const name = element.getName();
          // BindingElement.getType() resolves via the type checker
          // against the parameter's declared type — e.g. for
          // `({ label }: { label: string })`, that's `string`. Works
          // whether the annotation is inline or via a named interface.
          // Type.getText() returns the printed form; empty-string
          // returns (for unresolvable types) collapse to null.
          const typeText = element.getType().getText();
          result.push({
            name,
            position: inputMapping.paramPosition,
            role: name,
            typeText: typeText.length > 0 ? typeText : null,
          });
        }
      } else {
        // Non-destructured props (`function X(props) {...}`): one
        // Input for the whole object, role defaults to "props".
        const type = param.getType();
        result.push({
          name: param.getName(),
          position: inputMapping.paramPosition,
          role: inputMapping.wholeParamRole ?? "props",
          typeText: type.getText() || null,
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dependency-call extraction
// ---------------------------------------------------------------------------

function extractDependencyCalls(func: FunctionRoot): RawDependencyCall[] {
  const results: RawDependencyCall[] = [];

  func.forEachDescendant((node, traversal) => {
    // Don't descend into nested functions — their dep calls belong to them
    if (
      node !== func &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
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

    // assignedTo: simple identifier or destructured pattern
    const nameNode = node.getNameNode();
    const assignedTo = Node.isIdentifier(nameNode) ? nameNode.getText() : null;

    // VariableDeclaration → VariableDeclarationList → VariableStatement
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
        start: locationNode.getStartLineNumber(),
        end: locationNode.getEndLineNumber(),
      },
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Response property resolution
// ---------------------------------------------------------------------------

/**
 * Resolve response properties (e.g. `.ok`) in branch conditions using
 * the pack's declared response semantics. Produces more specific predicates
 * so the checker doesn't need framework-specific knowledge.
 *
 * For statusRange semantics (like fetch `.ok`), a truthinessCheck on the
 * property is replaced with a compound comparison on the status code.
 */
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

/**
 * If `ref` is a property access on the response dependency and that property
 * has `statusRange` semantics, produce a compound comparison predicate.
 *
 * Example: `.ok` on a fetch response → `status >= 200 && status <= 299`
 */
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

// ---------------------------------------------------------------------------
// Code structure extraction (per unit)
// ---------------------------------------------------------------------------

export function extractCodeStructure(
  unit: DiscoveredUnit,
  pack: PatternPack,
  filePath: string,
): RawCodeStructure {
  const { func, kind, name } = unit;
  const params = extractParameters(func, pack.inputMapping);
  let branches = extractRawBranches(func, pack.terminals);
  const depCalls = extractDependencyCalls(func);

  // For client units: resolve response properties and populate expectedInput
  if (unit.callSite !== undefined) {
    const calleeText = unit.callSite.callExpression.getExpression().getText();

    // Resolve response property semantics (e.g. .ok → status range)
    if (pack.responseSemantics !== undefined) {
      branches = resolveResponseProperties(
        branches,
        calleeText,
        pack.responseSemantics,
      );
    }

    // Populate expectedInput (body field accesses) on each branch
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

  // For client units, surface the pack's body-typed and statusCode-typed
  // response property names so cross-boundary checking can recognise the
  // pack-specific accessors (e.g. axios uses .data for body and .status for
  // status; fetch uses .body / .json() and .status).
  const bodyAccessors =
    unit.callSite !== undefined && pack.responseSemantics !== undefined
      ? pack.responseSemantics
          .filter((m) => m.semantics.type === "body")
          .map((m) => m.name)
      : undefined;
  const statusAccessors =
    unit.callSite !== undefined && pack.responseSemantics !== undefined
      ? pack.responseSemantics
          .filter((m) => m.semantics.type === "statusCode")
          .map((m) => m.name)
      : undefined;

  return {
    identity: {
      name,
      kind: kind as CodeUnitKind,
      file: filePath,
      range: {
        start: func.getStartLineNumber(),
        end: func.getEndLineNumber(),
      },
      exportName: name,
      exportPath: [name],
    },
    boundaryBinding: null,
    parameters: params,
    branches,
    dependencyCalls: depCalls,
    declaredContract: null,
    ...(bodyAccessors !== undefined && bodyAccessors.length > 0
      ? { bodyAccessors }
      : {}),
    ...(statusAccessors !== undefined && statusAccessors.length > 0
      ? { statusAccessors }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Consumer binding extraction
// ---------------------------------------------------------------------------

function extractConsumerBinding(
  unit: DiscoveredUnit,
  pattern: DiscoveryPattern,
  pack: PatternPack,
): {
  protocol: string;
  method?: string;
  path?: string;
  framework: string;
} | null {
  const callSite = unit.callSite;
  if (callSite === undefined) {
    return null;
  }

  const binding = pattern.bindingExtraction;
  if (binding === undefined) {
    return null;
  }

  let method: string | undefined;
  let path: string | undefined;

  method = extractBindingMethod(binding, callSite, pack);
  path = extractBindingPath(binding, callSite, pack);

  const result: {
    protocol: string;
    method?: string;
    path?: string;
    framework: string;
  } = { protocol: "http", framework: pack.name };
  if (method !== undefined) {
    result.method = method;
  }
  if (path !== undefined) {
    result.path = path;
  }
  return result;
}

function extractBindingMethod(
  binding: BindingExtraction,
  callSite: NonNullable<DiscoveredUnit["callSite"]>,
  pack: PatternPack,
): string | undefined {
  const m = binding.method;
  if (m.type === "fromClientMethod") {
    return resolveContractField(callSite, pack, "method");
  }
  if (m.type === "fromArgumentProperty") {
    const args = callSite.callExpression.getArguments();
    const arg = args[m.position];
    if (arg !== undefined && Node.isObjectLiteralExpression(arg)) {
      const prop = arg.getProperty(m.property);
      if (prop !== undefined && Node.isPropertyAssignment(prop)) {
        const init = prop.getInitializer();
        if (init !== undefined && Node.isStringLiteral(init)) {
          return init.getLiteralValue();
        }
      }
    }
    return m.default;
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
): string | undefined {
  const p = binding.path;
  if (p.type === "fromClientMethod") {
    return resolveContractField(callSite, pack, "path");
  }
  if (p.type === "fromArgumentLiteral") {
    const args = callSite.callExpression.getArguments();
    const arg = args[p.position];
    if (arg === undefined) {
      return undefined;
    }
    if (Node.isStringLiteral(arg)) {
      return arg.getLiteralValue();
    }
    if (Node.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.getLiteralValue();
    }
    if (Node.isTemplateExpression(arg)) {
      // `/pet/${id}/comments/${commentId}` →
      // `/pet/{id}/comments/{commentId}`. Each substitution becomes an
      // OpenAPI-style placeholder; the checker's path normalizer treats
      // `{id}` and `:id` as equivalent so this pairs with both Express
      // and ts-rest-style provider paths too.
      let path = arg.getHead().getLiteralText();
      for (const span of arg.getTemplateSpans()) {
        path += `{${placeholderName(span.getExpression())}}`;
        path += span.getLiteral().getLiteralText();
      }
      return path;
    }
    return undefined;
  }
  return undefined;
}

function placeholderName(expr: Node): string {
  if (Node.isIdentifier(expr)) {
    return expr.getText();
  }
  if (Node.isPropertyAccessExpression(expr)) {
    // Use the trailing segment (`req.params.id` → `id`) — keeps the path
    // readable and matches what API authors typically name the segment.
    return expr.getName();
  }
  return "param";
}

function resolveContractField(
  callSite: NonNullable<DiscoveredUnit["callSite"]>,
  pack: PatternPack,
  field: "method" | "path",
): string | undefined {
  if (pack.contractReading === undefined || callSite.methodName === null) {
    return undefined;
  }
  const result = readContractForClientCall(
    callSite.callExpression,
    callSite.methodName,
    pack.contractReading,
  );
  if (result === null) {
    return undefined;
  }
  if (field === "method") {
    return result.boundaryBinding?.method;
  }
  return result.boundaryBinding?.path;
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

function extractFromSourceFile(
  sourceFile: SourceFile,
  frameworks: PatternPack[],
  options?: ExtractorOptions,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const filePath = sourceFile.getFilePath();

  for (const pack of frameworks) {
    const units = discoverUnits(sourceFile, pack.discovery);

    for (const unit of units) {
      const raw = extractCodeStructure(unit, pack, filePath);

      // The discovery pattern that produced this unit is attached by
      // discoverUnits — fall back to the first kind-match if missing so older
      // call paths keep working.
      const matchedPattern =
        unit.pattern ?? pack.discovery.find((d) => d.kind === unit.kind);

      if (unit.callSite !== undefined && matchedPattern !== undefined) {
        // Consumer: extract binding from call site
        const binding = extractConsumerBinding(unit, matchedPattern, pack);
        if (binding !== null) {
          raw.boundaryBinding = binding;
        }
      } else if (pack.contractReading !== undefined) {
        // Provider: attempt contract reading
        const contract = readContract(unit, pack.contractReading);
        if (contract !== null) {
          raw.declaredContract = contract.declaredContract;
          if (contract.boundaryBinding !== null) {
            raw.boundaryBinding = contract.boundaryBinding;
          }
        }
      }

      // Fill in a default boundary binding if none from contract
      if (raw.boundaryBinding === null) {
        raw.boundaryBinding = {
          protocol: "http",
          framework: pack.name,
        };
      }

      summaries.push(assembleSummary(raw, options));
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Wrapper expansion (cross-function path resolution)
// ---------------------------------------------------------------------------
//
// A "wrapper" is a thin client function whose path argument is forwarded
// from one of its own parameters: e.g.
//
//   export async function getJson<T>(path: string): Promise<T> {
//     const { data } = await api.get(path);
//     return data;
//   }
//
// Discovery sees getJson as a client unit because it contains an axios call,
// but bindingExtraction can't pin a path — `path` is a parameter, not a
// literal. Pure-source consumers that call `getJson("/pet/1")` are then
// invisible to the checker because no summary exists for them.
//
// expandWrapperCallers does a post-pass: for each wrapper-shaped client
// summary it finds the containing function, asks ts-morph for callers
// across the project, and synthesises a thin client summary per caller
// where the path comes from the caller's literal argument. The synthesised
// summary participates in pairing and unhandled-status checks; it does NOT
// carry through caller-local conditional branches or expectedInput field
// tracking — those are out of scope for v0 cross-function analysis.

interface WrapperInfo {
  summary: BehavioralSummary;
  func: FunctionRoot;
  pathParamPosition: number;
}

function expandWrapperCallers(
  summaries: BehavioralSummary[],
  project: Project,
  options?: ExtractorOptions,
): BehavioralSummary[] {
  const wrappers: WrapperInfo[] = [];

  for (const s of summaries) {
    if (s.kind !== "client") {
      continue;
    }
    const binding = s.identity.boundaryBinding;
    if (
      binding === null ||
      binding.method === undefined ||
      binding.path !== undefined
    ) {
      continue;
    }
    const located = findWrapperPathParam(s, project);
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
    derived.push(...synthesizeCallerSummaries(wrapper, project, options));
  }
  return [...summaries, ...derived];
}

function findWrapperPathParam(
  summary: BehavioralSummary,
  project: Project,
): { func: FunctionRoot; pathParamPosition: number } | null {
  // Find the function in the project. summary.location.file is project-
  // relative for portability; ts-morph stores absolute paths so we have to
  // match by suffix.
  const func = locateFunction(summary, project);
  if (func === null) {
    return null;
  }
  // Look at the function's parameters; the one whose name appears as a
  // call argument inside the function (in any descendant CallExpression
  // arg-0 position) is our best guess at the path parameter. We use the
  // first parameter as the heuristic for v0 — fits axios and ts-rest
  // wrapper conventions where the path is parameter zero.
  const params = func.getParameters();
  if (params.length === 0) {
    return null;
  }
  return { func, pathParamPosition: 0 };
}

function locateFunction(
  summary: BehavioralSummary,
  project: Project,
): FunctionRoot | null {
  for (const sf of project.getSourceFiles()) {
    if (!sf.getFilePath().endsWith(summary.location.file)) {
      continue;
    }
    const candidates: FunctionRoot[] = [];
    sf.forEachDescendant((node) => {
      if (
        Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node)
      ) {
        if (
          node.getStartLineNumber() === summary.location.range.start &&
          node.getEndLineNumber() === summary.location.range.end
        ) {
          candidates.push(node as FunctionRoot);
        }
      }
    });
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  return null;
}

function synthesizeCallerSummaries(
  wrapper: WrapperInfo,
  project: Project,
  options?: ExtractorOptions,
): BehavioralSummary[] {
  // Find the wrapper's identifier so we can ask ts-morph for references.
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
    const path = literalOrTemplate(pathArg);
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
  // Arrow / function expressions: the identifier we want is the variable
  // they're bound to (`export const getJson = ...`).
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
  // Skip past intervening identifier/property-access wrapping to reach the
  // call expression where this reference is the callee.
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

function literalOrTemplate(arg: Node): string | undefined {
  if (Node.isStringLiteral(arg)) {
    return arg.getLiteralValue();
  }
  if (Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralValue();
  }
  if (Node.isTemplateExpression(arg)) {
    let path = arg.getHead().getLiteralText();
    for (const span of arg.getTemplateSpans()) {
      path += `{${placeholderName(span.getExpression())}}`;
      path += span.getLiteral().getLiteralText();
    }
    return path;
  }
  return undefined;
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
  const sf = callerFunc.getSourceFile();
  const file = sf.getFilePath();
  const wrapperBinding = wrapper.summary.identity.boundaryBinding;

  // Run the caller through the same extraction pipeline used for direct
  // clientCall consumers. The wrapper call site stands in for the API call
  // — branch tracking, terminal extraction, and field-access tracking on
  // the wrapper return value all flow through the existing code paths.
  //
  // The synthetic pack carries no responseSemantics: the wrapper has
  // already unwrapped the response, so caller-side accesses on the
  // wrapper return value are already body-relative — there's no `data`
  // or `body` key to filter.
  const syntheticPack: PatternPack = {
    name: wrapperBinding?.framework ?? "unknown",
    languages: ["typescript"],
    discovery: [],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
    // Empty (not absent): tells field-access tracking that there's no
    // response wrapper to filter on — every property is a body field.
    // Without this the hardcoded fallback would drop `status` / `headers`
    // accesses that are perfectly legitimate on an unwrapped body.
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

  const raw = extractCodeStructure(unit, syntheticPack, file);
  raw.boundaryBinding = {
    protocol: wrapperBinding?.protocol ?? "http",
    framework: wrapperBinding?.framework ?? "unknown",
    ...(wrapperBinding?.method !== undefined
      ? { method: wrapperBinding.method }
      : {}),
    path,
  };

  const summary = assembleSummary(raw, options);
  // Stitch wrapper-origin metadata so consumers can trace synthesised
  // summaries back to the wrapper they came from. assembleSummary may
  // already have set metadata for declaredContract or bodyAccessors —
  // merge rather than overwrite.
  summary.metadata = {
    ...(summary.metadata ?? {}),
    derivedFromWrapper: {
      file: wrapper.summary.location.file,
      name: wrapper.summary.identity.name,
    },
  };
  // Wrapper-derived summaries are inferred indirectly; weight accordingly.
  summary.confidence = { source: "inferred_static", level: "low" };
  return summary;
}

// ---------------------------------------------------------------------------
// Public adapter API
// ---------------------------------------------------------------------------

export interface TypeScriptAdapterConfig {
  tsConfigFilePath?: string;
  project?: Project;
  frameworks: PatternPack[];
  extractorOptions?: ExtractorOptions;
}

export interface TypeScriptAdapter {
  project: Project;
  extractFromFiles(filePaths: string[]): BehavioralSummary[];
  extractAll(): BehavioralSummary[];
}

export function createTypeScriptAdapter(
  config: TypeScriptAdapterConfig,
): TypeScriptAdapter {
  const project =
    config.project ??
    new Project(
      config.tsConfigFilePath !== undefined
        ? { tsConfigFilePath: config.tsConfigFilePath }
        : { skipAddingFilesFromTsConfig: true },
    );

  return {
    project,

    extractFromFiles(filePaths: string[]): BehavioralSummary[] {
      const summaries: BehavioralSummary[] = [];

      for (const fp of filePaths) {
        const sourceFile = project.getSourceFile(fp);
        if (sourceFile === undefined) {
          continue;
        }
        summaries.push(
          ...extractFromSourceFile(
            sourceFile,
            config.frameworks,
            config.extractorOptions,
          ),
        );
      }

      return summaries;
    },

    extractAll(): BehavioralSummary[] {
      const summaries: BehavioralSummary[] = [];

      for (const sourceFile of project.getSourceFiles()) {
        if (sourceFile.isDeclarationFile()) {
          continue;
        }
        summaries.push(
          ...extractFromSourceFile(
            sourceFile,
            config.frameworks,
            config.extractorOptions,
          ),
        );
      }

      return expandWrapperCallers(summaries, project, config.extractorOptions);
    },
  };
}
