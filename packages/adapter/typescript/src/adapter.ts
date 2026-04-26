// adapter.ts — Full adapter orchestration (Task 2.5b)
//
// Wires together: discovery → extractCodeStructure → readContract → assembleSummary

import path from "node:path";

import {
  type CallExpression,
  type Identifier,
  Node,
  Project,
  type SourceFile,
} from "ts-morph";

import {
  functionCallBinding,
  graphqlOperationBinding,
  graphqlResolverBinding,
  packageExportBinding,
  restBinding,
} from "@suss/behavioral-ir";
import {
  type AccessRecognizer,
  assembleSummary,
  type BindingExtraction,
  type DiscoveredSubUnit,
  type DiscoveredSubUnitParent,
  type DiscoveryPattern,
  type ExtractorOptions,
  type InputMappingPattern,
  type InvocationRecognizer,
  type PatternPack,
  type RawBranch,
  type RawCodeStructure,
  type RawDependencyCall,
  type RawParameter,
  type ResponsePropertyMapping,
  type TerminalPattern,
} from "@suss/extractor";

import { extractRawBranches } from "./assembly.js";
import {
  createLazyProject,
  readTsconfigFileList,
} from "./bootstrap/lazyProjectInit.js";
import { computePackApplicability } from "./bootstrap/preFilter.js";
import {
  type CacheDiagnostic,
  type CacheLayer,
  createCacheLayer,
} from "./cache.js";
import { readContract, readContractForClientCall } from "./contract.js";
import { type DiscoveredUnit, discoverUnits } from "./discovery/index.js";
import { expandReachableClosure } from "./resolve/reachableClosure.js";
import { enrichRethrows } from "./resolve/rethrowEnrichment.js";
import { collectClientFieldAccesses } from "./shapes/fieldAccesses.js";
import { createTsSubUnitContext } from "./subUnitContext.js";
import { createTimer, type TimingReport } from "./timing.js";
import { computeAdapterPacksDigest } from "./version.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  CodeUnitKind,
  Predicate,
  ValueRef,
} from "@suss/behavioral-ir";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Throws an Error with the given message; typed as `never` so it narrows. */
const raise = (msg: string): never => {
  throw new Error(msg);
};

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

/**
 * Expand a destructured parameter binding pattern into its bound names.
 * Handles both `{ a, b }` and `[a, b]` forms. Rest elements (`...rest`)
 * surface under their rest-binding name; array holes (`[, , a]`) are
 * skipped. Returns null when the node isn't a binding pattern, so callers
 * can fall back to treating the parameter as a single value.
 */
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
      const boundNames = bindingPatternNames(nameNode);
      if (boundNames !== null) {
        for (const name of boundNames) {
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
  } else if (inputMapping.type === "allPositional") {
    // Emit one Input per declared parameter. Destructured bindings
    // (object or array) expand into one Input per bound name, so
    // `(ctx, { userId, count })` reads as three inputs and
    // `([state, setState]) => ...` reads as two.
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const nameNode = param.getNameNode();
      const boundNames = bindingPatternNames(nameNode);
      if (boundNames !== null) {
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
    // NestJS-style: each parameter's first decorator names its role
    // (e.g. `@Args() id` → role "args"). Unmatched parameters fall
    // back to `defaultRole` when set, or skip when unset, so a stray
    // injected service doesn't surface as an input.
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
  invocationRecognizers: InvocationRecognizer[] = [],
  accessRecognizers: AccessRecognizer[] = [],
): RawCodeStructure {
  const { func, kind, name } = unit;
  const params = extractParameters(func, pack.inputMapping);
  let branches = extractRawBranches(
    func,
    pack.terminals,
    invocationRecognizers,
    accessRecognizers,
  );
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
): BoundaryBinding | null {
  const callSite = unit.callSite;
  if (callSite === undefined) {
    return null;
  }

  const binding = pattern.bindingExtraction;
  if (binding === undefined) {
    return null;
  }

  const method = extractBindingMethod(binding, callSite, pack);
  const path = extractBindingPath(binding, callSite, pack);

  // Consumer bindings without both method and path can't be placed as
  // REST. Return a rest-shaped partial so downstream code can still
  // see what was extracted — `path` staying empty is the signal
  // wrapper-expansion uses to detect forwarding wrappers.
  return restBinding({
    transport: pack.protocol,
    method: method ?? "",
    path: path ?? "",
    recognition: pack.name,
  });
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
  if (result === null || result.boundaryBinding === null) {
    return undefined;
  }
  const semantics = result.boundaryBinding.semantics;
  if (semantics.name !== "rest") {
    return undefined;
  }
  const value = field === "method" ? semantics.method : semantics.path;
  return value === "" ? undefined : value;
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

/**
 * Aggregate `invocationRecognizers` across every pack in the
 * framework list. Extraction passes the same flat list to every
 * top-level and sub-unit extraction so a recognizer fires regardless
 * of which pack discovered the enclosing function.
 */
function collectInvocationRecognizers(
  frameworks: PatternPack[],
): InvocationRecognizer[] {
  const out: InvocationRecognizer[] = [];
  for (const pack of frameworks) {
    if (pack.invocationRecognizers === undefined) {
      continue;
    }
    out.push(...pack.invocationRecognizers);
  }
  return out;
}

function collectAccessRecognizers(
  frameworks: PatternPack[],
): AccessRecognizer[] {
  const out: AccessRecognizer[] = [];
  for (const pack of frameworks) {
    if (pack.accessRecognizers === undefined) {
      continue;
    }
    out.push(...pack.accessRecognizers);
  }
  return out;
}

function extractFromSourceFile(
  sourceFile: SourceFile,
  frameworks: PatternPack[],
  options?: ExtractorOptions,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const filePath = sourceFile.getFilePath();
  // Aggregate recognizers from EVERY pack — a Prisma recognizer fires
  // on Prisma calls inside an Express handler regardless of which pack
  // discovered the handler. Same threading model as the cross-pack
  // claim dedup below.
  const allInvocationRecognizers = collectInvocationRecognizers(frameworks);
  const allAccessRecognizers = collectAccessRecognizers(frameworks);

  // Cross-pack dedup: when two packs both claim the same (function, kind)
  // — e.g. React and React Router both discovering a default-exported
  // component — the first pack wins and later packs skip. Pack order in
  // `frameworks` is the user's precedence signal: `-f react -f react-router`
  // gives React components; `-f react-router -f react` gives RR-labeled
  // components. Without this the same source function would produce two
  // independent summaries at different recognition labels.
  const claimed = new Set<string>();

  for (const pack of frameworks) {
    const units = discoverUnits(sourceFile, pack.discovery);

    for (const unit of units) {
      const claimKey = `${unit.func.getStart()}-${unit.func.getEnd()}-${unit.kind}`;
      if (claimed.has(claimKey)) {
        continue;
      }
      claimed.add(claimKey);
      const raw = extractCodeStructure(
        unit,
        pack,
        filePath,
        allInvocationRecognizers,
        allAccessRecognizers,
      );

      // The discovery pattern that produced this unit is attached by
      // discoverUnits — fall back to the first kind-match if missing so older
      // call paths keep working.
      const matchedPattern =
        unit.pattern ?? pack.discovery.find((d) => d.kind === unit.kind);

      if (unit.resolverInfo !== undefined) {
        // GraphQL resolver (code-first): bind directly from the
        // discovery-derived typeName + fieldName. No REST shape
        // applies; skip the REST binding-extraction path.
        raw.boundaryBinding = graphqlResolverBinding({
          transport: pack.protocol,
          recognition: pack.name,
          typeName: unit.resolverInfo.typeName,
          fieldName: unit.resolverInfo.fieldName,
        });
        // When the pack captured typeDefs alongside the resolver
        // map (Apollo code-first), carry the SDL through so the
        // checker can walk nested selections against the return
        // type's fields — the parallel of what stub-appsync
        // already does for schema-first AppSync resolvers.
        if (unit.resolverInfo.schemaSdl !== undefined) {
          raw.graphqlSchemaSdl = unit.resolverInfo.schemaSdl;
        }
      } else if (unit.routeInfo !== undefined) {
        // NestJS-style REST controller: bind directly from the
        // discovery-derived (method, path). Same shape as Express /
        // Fastify produce via `bindingExtraction`, but without the
        // registration-call walking — decorators carry the route
        // statically on the method itself.
        raw.boundaryBinding = restBinding({
          transport: pack.protocol,
          recognition: pack.name,
          method: unit.routeInfo.method,
          path: unit.routeInfo.path,
        });
      } else if (unit.operationInfo !== undefined) {
        // GraphQL operation (consumer-side hook): bind from the
        // parsed operation header. Same logic as resolvers — skip
        // the REST binding-extraction path since the shape is
        // already determined at discovery time by graphql-js.
        raw.boundaryBinding = graphqlOperationBinding({
          transport: pack.protocol,
          recognition: pack.name,
          operationType: unit.operationInfo.operationType,
          ...(unit.operationInfo.operationName !== undefined
            ? { operationName: unit.operationInfo.operationName }
            : {}),
        });
        // Carry the raw document through so the checker's pairing
        // layer can re-parse if it needs shapes we don't surface.
        raw.graphqlDocument = unit.operationInfo.document;
        // Each `$name: Type` variable in the operation header
        // becomes an Input on the summary. Role `"variable"` keeps
        // them distinguishable from positional callback params when
        // the same unit has both (rare, but possible if a hook
        // argument forwards a callback).
        for (const v of unit.operationInfo.variables) {
          raw.parameters.push({
            name: v.name,
            position: raw.parameters.length,
            role: "variable",
            // `v.type` already prints the `!` suffix for non-null
            // types; don't re-append.
            typeText: v.type,
          });
        }
      } else if (unit.callSite !== undefined && matchedPattern !== undefined) {
        // Consumer: extract binding from call site
        const binding = extractConsumerBinding(unit, matchedPattern, pack);
        if (binding !== null) {
          raw.boundaryBinding = binding;
          // Additive migration of clientCall to the unified interaction
          // shape (#180): in addition to the synthesized client-kind
          // summary (which keeps working for existing pairing logic),
          // stamp an interaction(class: "service-call") effect on the
          // default-branch transition. The unified pairing dispatcher
          // (#174) can then enumerate service-call interactions through
          // the same machinery used by storage / message-bus / config-
          // read. Today no consumer of those effects exists yet (no
          // service-call finding generator), so this is purely
          // structural. When that finding generator lands, fetch /
          // axios / apollo calls become discoverable through the
          // unified shape without rewriting clientCall discovery
          // itself.
          if (binding.semantics.name === "rest") {
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
        // Provider: attempt contract reading
        const contract = readContract(unit, pack.contractReading);
        if (contract !== null) {
          raw.declaredContract = contract.declaredContract;
          if (contract.boundaryBinding !== null) {
            raw.boundaryBinding = contract.boundaryBinding;
          }
        }
      }

      // Fill in a default boundary binding if none from contract.
      // Without a discovery-derived rest binding to carry method/path,
      // fall back to function-call semantics — the unit is a
      // TypeScript function with no REST shape attached. Consumer /
      // provider dispatch (via BOUNDARY_ROLE on `kind`) still works.
      //
      // `packageExportInfo` (from the `packageExports` discovery
      // variant) supplies the stronger `package` + `exportPath`
      // identity when the unit is a publicly-exported library
      // function — use it to build a package-export binding so the
      // checker can pair providers with consumer import sites
      // once that side lands.
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
          });
        }
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
    // Wrappers are rest-shaped clients whose path came back empty
    // (method extracted, path unresolved — the `path` param is a
    // function parameter, not a literal). Everything else skips.
    if (
      binding === null ||
      binding.semantics.name !== "rest" ||
      binding.semantics.method === "" ||
      binding.semantics.path !== ""
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
  _project: Project,
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
  const wrapperRest =
    wrapperBinding?.semantics.name === "rest" ? wrapperBinding.semantics : null;

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
    name: wrapperBinding?.recognition ?? "unknown",
    // Wrapper-expansion synthesizes summaries whose boundary binding
    // is overwritten immediately below, so the pack's protocol is a
    // placeholder. Inherit the wrapper's transport when present to
    // avoid inventing identity; fall back to "http" because wrapper
    // expansion only applies to HTTP clients today.
    protocol: wrapperBinding?.transport ?? "http",
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
  raw.boundaryBinding = restBinding({
    transport: wrapperBinding?.transport ?? "http",
    method: wrapperRest?.method ?? "",
    path,
    recognition: wrapperBinding?.recognition ?? "unknown",
  });

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
  /**
   * Include library summaries for every function reachable through a
   * static call edge from a pack-discovered unit. Defaults to `true` —
   * internal orchestrators, helpers, and utilities that frameworks
   * don't recognise become `library`-kind summaries with
   * `recognition: "reachable"` so readers can see their behaviour.
   * Set to `false` for pack-only extraction (smaller output; only the
   * units packs explicitly claim).
   */
  includeReachable?: boolean;
  /**
   * Called once at the end of each `extractAll` / `extractFromFiles`
   * with the wall-clock breakdown of the major extraction phases.
   * Always-on instrumentation cost is negligible (millisecond-scale
   * `performance.now()` calls); the callback is the opt-in for
   * surfacing it. CLI uses this to render the per-extract summary
   * line and the `--timing` breakdown.
   */
  onTiming?: (report: TimingReport) => void;
  /**
   * Called once per extract with the cache hit/miss decision and the
   * partial-reuse diagnostic — counts of cached summaries that fine-
   * grained invalidation would have salvaged on a coarse miss.
   * Phase 4a uses this to validate the dep-tracking model before
   * activating partial-reuse.
   */
  onCacheDiagnostic?: (diagnostic: CacheDiagnostic) => void;
  /**
   * On-disk cache directory for the coarse-key extraction cache.
   * Pass an absolute path; defaults to `.suss/cache/` next to the
   * tsconfig (or under cwd when no tsconfig path is supplied).
   * Pass `null` to disable caching entirely. The cache stores one
   * `manifest.json` keyed against (adapter version, pack versions,
   * sorted file mtime/size stamps); on a warm run with no changes
   * the lookup is stat-only and skips extraction.
   */
  cacheDir?: string | null;
}

export interface TypeScriptAdapter {
  project: Project;
  /**
   * Extract summaries from a specific list of files. Returns a
   * Promise so the implementation can do concurrent I/O during
   * the pre-filter / lazy-load phases without bottlenecking on
   * sync `fs.readFileSync`.
   */
  extractFromFiles(filePaths: string[]): Promise<BehavioralSummary[]>;
  /** Extract summaries from every (non-declaration) file the Project knows about. */
  extractAll(): Promise<BehavioralSummary[]>;
}

export function createTypeScriptAdapter(
  config: TypeScriptAdapterConfig,
): TypeScriptAdapter {
  // Project bootstrap strategy:
  //   - Caller passed `config.project`: use it directly (test
  //     fixtures, programmatic Project, in-memory FS).
  //   - Caller passed `config.tsConfigFilePath`: defer the file
  //     loading. Construct an empty Project here and let
  //     `extractAll` populate it via the lazy-load path
  //     (preProcessFile-based pre-filter + per-pack gate
  //     applicability), parsing only what the active packs care
  //     about.
  //   - Neither: empty Project, caller is responsible.
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

  let lazyBootstrapped = false;
  // Captured from createLazyProject — the full tsconfig include set,
  // regardless of whether the bootstrap pre-loaded each file. Closure
  // expansion uses it to lazy-add callee files it walks into without
  // pulling in anything outside the project (node_modules, etc.).
  let projectFileSet: ReadonlySet<string> | undefined;

  // Resolve the cache directory:
  //   - explicit `null` opts out
  //   - explicit string is used verbatim
  //   - default: `.suss/cache/` next to the tsconfig WHEN a
  //     `tsConfigFilePath` was supplied. Callers that hand in a
  //     pre-built `project` (programmatic / in-memory / test
  //     fixtures) get no disk cache by default — the manifest
  //     would have nowhere meaningful to live and the stat
  //     check against in-memory paths would always miss.
  const cacheDir =
    config.cacheDir === null
      ? null
      : (config.cacheDir ??
        (config.tsConfigFilePath !== undefined
          ? path.join(path.dirname(config.tsConfigFilePath), ".suss", "cache")
          : null));
  const cache: CacheLayer = createCacheLayer(cacheDir);
  const adapterPacksDigest = computeAdapterPacksDigest(
    config.frameworks.map((p) =>
      p.version !== undefined
        ? { name: p.name, version: p.version }
        : { name: p.name },
    ),
  );

  return {
    project,

    async extractFromFiles(filePaths: string[]): Promise<BehavioralSummary[]> {
      const summaries: BehavioralSummary[] = [];

      for (const fp of filePaths) {
        // Project may have skipped initial loading (lazy
        // bootstrap path). The caller named these files
        // explicitly — pull them in now if they aren't
        // already loaded.
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
            config.extractorOptions,
          ),
        );
      }

      return summaries;
    },

    async extractAll(): Promise<BehavioralSummary[]> {
      const timer = createTimer();

      // For lazy-bootstrap-eligible runs (tsconfig path supplied
      // by caller), get the include file list cheaply via the TS
      // config parser BEFORE bootstrap. This lets the cache check
      // run against the canonical file list directly — a cache
      // hit then short-circuits before paying for any file
      // reading or AST parsing.
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

      // Coarse-key cache check. Uses the tsconfig file list when
      // available (lazy-eligible path) so a hit doesn't trigger
      // bootstrap. Falls back to the Project's loaded source
      // files for caller-supplied Project consumers.
      const cacheInput =
        tsconfigFileList !== null
          ? {
              files: tsconfigFileList,
              adapterPacksDigest,
              tsconfigPath:
                config.tsConfigFilePath ??
                raise("lazy bootstrap requires tsConfigFilePath"),
            }
          : {
              project,
              adapterPacksDigest,
              ...(config.tsConfigFilePath !== undefined
                ? { tsconfigPath: config.tsConfigFilePath }
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
        return lookup.summaries;
      }
      const partial = lookup.kind === "partial-hit" ? lookup : null;

      // Cache miss / partial hit: run the lazy bootstrap so the rest
      // of the pipeline has the candidate set loaded. On a partial
      // hit we additionally pull in:
      //   - filesToExtract (per-file extract needs them loaded)
      //   - every kept summary's location.file (closure pass needs to
      //     locate kept summaries' AST nodes by file+range; if a file
      //     isn't loaded the locate fails and closure re-emits the
      //     summary as a duplicate).
      if (lazyEligible) {
        const lazy = await timer.timeAsync("lazyProjectInit", () =>
          createLazyProject(
            config.tsConfigFilePath ??
              raise("lazy bootstrap requires tsConfigFilePath"),
            config.frameworks,
          ),
        );
        for (const sf of lazy.loadedFiles) {
          // addSourceFileAtPath is a no-op when the file is
          // already present — keeps the project reference stable
          // for downstream consumers.
          project.addSourceFileAtPath(sf.getFilePath());
        }
        if (partial !== null) {
          const partialFiles = new Set<string>(partial.filesToExtract);
          for (const summary of partial.kept) {
            partialFiles.add(summary.location.file);
          }
          for (const fp of partialFiles) {
            try {
              project.addSourceFileAtPath(fp);
            } catch {
              // File listed in tsconfig but disappeared between the
              // cache-list collection and addSourceFileAtPath — skip
              // silently; subsequent phases tolerate missing files.
            }
          }
        }
        projectFileSet = lazy.projectFileSet;
        lazyBootstrapped = true;
      }

      const summaries: BehavioralSummary[] =
        partial !== null ? [...partial.kept] : [];

      // One project enumeration, reused across phases. `getSourceFiles`
      // walks the directory tree internally — calling it per-phase
      // (and per-summary in the locate paths) is the dominant cost
      // on large monorepos.
      const sourceFiles = timer.time("project.getSourceFiles", () =>
        project.getSourceFiles().filter((sf) => !sf.isDeclarationFile()),
      );

      // Pre-filter: for each file, figure out which packs have any
      // pattern that could match (based on `requiresImport` gates
      // against the file's imports). Files where NO pack matches
      // skip the discovery walk entirely. Big speedup on
      // monorepo-scale projects where most files don't touch any
      // framework the active packs care about.
      const packsByFile = timer.time("preFilter", () =>
        computePackApplicability(sourceFiles, config.frameworks),
      );

      // Per-file extract: the FULL pass walks every source file; the
      // partial-hit pass walks only the changed/added subset and
      // merges them with the kept summaries above.
      const filesToExtractSet =
        partial !== null ? new Set(partial.filesToExtract) : null;
      timer.time("extract per-file", () => {
        for (const sourceFile of sourceFiles) {
          if (
            filesToExtractSet !== null &&
            !filesToExtractSet.has(sourceFile.getFilePath())
          ) {
            continue;
          }
          const applicablePacks = packsByFile.get(sourceFile);
          if (applicablePacks === undefined) {
            continue;
          }
          summaries.push(
            ...extractFromSourceFile(
              sourceFile,
              applicablePacks,
              config.extractorOptions,
            ),
          );
        }
      });

      const withWrappers = timer.time("expandWrapperCallers", () =>
        expandWrapperCallers(summaries, project, config.extractorOptions),
      );
      const withSubUnits = timer.time("synthesizeSubUnits", () =>
        synthesizeSubUnits(
          withWrappers,
          project,
          config.frameworks,
          config.extractorOptions,
        ),
      );
      // Transitive-closure pass: every function reachable through a static
      // call edge from an already-summarized unit becomes a `library`
      // summary. Gated by `includeReachable` (default true) so callers
      // can opt out for pack-only extraction.
      //
      // We pass `projectFileSet` so closure can lazy-add each callee's
      // source file the moment it walks into a new one. Without this,
      // ts-morph's symbol resolution loads callee files into the
      // underlying program but leaves them off project.getSourceFiles(),
      // and the rethrow-enrichment lookup (built from that list) silently
      // skips closure-derived summaries.
      const withClosure =
        config.includeReachable !== false
          ? timer.time("expandReachableClosure", () =>
              expandReachableClosure(
                withSubUnits,
                project,
                config.extractorOptions,
                projectFileSet,
              ),
            )
          : withSubUnits;

      // Rethrow enrichment: bare `throw err` inside a catch block picks
      // up `transition.metadata.rethrow.possibleSources` — the set of
      // exceptions its enclosing try block's call sites could produce,
      // read off those callees' summaries. Runs last so every callee's
      // throw terminals (including reachable-closure ones) are available
      // to consult.
      const enriched = timer.time("enrichRethrows", () =>
        enrichRethrows(withClosure, project),
      );

      // Persist to the coarse-key cache so subsequent runs with
      // identical Project state can short-circuit. Errors during
      // write are swallowed — a failed cache write shouldn't
      // fail the extract.
      await timer.timeAsync("cache.write", async () => {
        try {
          await cache.write(cacheInput, enriched);
        } catch {
          // intentionally silent
        }
      });

      if (config.onTiming !== undefined) {
        config.onTiming(timer.report());
      }

      return enriched;
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-unit synthesis (generic: driven by pack.subUnits)
// ---------------------------------------------------------------------------
//
// Some frameworks' runtimes schedule N user-authored callbacks from one
// source-level construct: React components spawn event handlers and
// effect bodies; Node EventEmitter usage spawns `.on(...)` handlers;
// GraphQL types spawn field resolvers; class components spawn lifecycle
// methods. The pack describes these via its optional `subUnits` hook:
// given a parent DiscoveredUnit and a TypeScript-adapter context, it
// returns child DiscoveredUnits each carrying its own extraction spec.
//
// The adapter's role is: iterate summaries, find their originating
// pack, invoke `subUnits`, pipe every returned unit through the same
// extraction + assembly pipeline used for top-level discovery, and
// stamp pack-supplied metadata onto each resulting summary.

function synthesizeSubUnits(
  summaries: BehavioralSummary[],
  project: Project,
  frameworks: PatternPack[],
  options?: ExtractorOptions,
): BehavioralSummary[] {
  const packByRecognition = new Map<string, PatternPack>();
  for (const pack of frameworks) {
    packByRecognition.set(pack.name, pack);
  }
  // Sub-units run through the same recognizer set as top-level
  // discovered units — a Prisma call inside a React useEffect body
  // should still emit interaction(class: "storage-access").
  const allInvocationRecognizers = collectInvocationRecognizers(frameworks);
  const allAccessRecognizers = collectAccessRecognizers(frameworks);

  const synthesized: BehavioralSummary[] = [];
  const subUnitCtx = createTsSubUnitContext();

  for (const parent of summaries) {
    const binding = parent.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    const pack = packByRecognition.get(binding.recognition);
    if (pack?.subUnits === undefined) {
      continue;
    }

    const parentFunc = locateFunction(parent, project);
    if (parentFunc === null) {
      continue;
    }

    const parentHandle: DiscoveredSubUnitParent = {
      func: parentFunc,
      name: parent.identity.name,
      kind: parent.kind,
    };

    const subUnits = pack.subUnits(parentHandle, subUnitCtx);
    const filePath = parentFunc.getSourceFile().getFilePath();

    for (const subUnit of subUnits) {
      const summary = buildSubUnitSummary(
        subUnit,
        parent,
        filePath,
        allInvocationRecognizers,
        allAccessRecognizers,
        options,
      );
      if (summary !== null) {
        synthesized.push(summary);
      }
    }
  }

  return [...summaries, ...synthesized];
}

const DEFAULT_SUB_UNIT_TERMINALS: TerminalPattern[] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  // Sub-units are callbacks — event handlers, `useEffect` bodies,
  // Node listeners — that routinely fall off the end returning
  // `undefined`. Opt into fall-through here so synthesised summaries
  // get a default transition even without an explicit return. HTTP
  // packs (Express / Fastify / ts-rest handlers) deliberately do NOT
  // opt in: a handler that falls through without sending a response
  // is a bug and should surface as "no transitions" for the gap
  // detector to flag.
  {
    kind: "return",
    match: { type: "functionFallthrough" },
    extraction: {},
  },
];

const DEFAULT_SUB_UNIT_INPUT_MAPPING: InputMappingPattern = {
  type: "positionalParams",
  params: [],
};

function buildSubUnitSummary(
  subUnit: DiscoveredSubUnit,
  parent: BehavioralSummary,
  filePath: string,
  invocationRecognizers: InvocationRecognizer[],
  accessRecognizers: AccessRecognizer[],
  options?: ExtractorOptions,
): BehavioralSummary | null {
  const func = subUnit.func as FunctionRoot;

  // Build a minimal pack scaffolding just for this extraction. The
  // pack is ephemeral — it never ships in a framework list; it's here
  // only to parameterise `extractCodeStructure` for the sub-unit body.
  const scaffoldPack: PatternPack = {
    name: "sub-unit",
    // Scaffold protocol is overwritten below by the parent's
    // inherited boundary binding. Pick a placeholder that won't
    // collide with a shipped pack identity.
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
    filePath,
    invocationRecognizers,
    accessRecognizers,
  );

  // Inherit the parent's boundary binding wholesale. Sub-units share
  // the parent's runtime — a React component's handler is bound to
  // the same React framework; a Node EventEmitter `.on()` handler is
  // bound to the same Node runtime. This keeps re-entry through
  // `synthesizeSubUnits` (if it ever becomes recursive) routing
  // correctly, and means the pack doesn't have to re-declare its
  // own identity on every sub-unit.
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
  // Sub-units are inferred indirectly and often have thin effect
  // coverage until the effect-body capture work lands. Mark medium.
  summary.confidence = { source: "inferred_static", level: "medium" };
  return summary;
}
