// discovery.ts: find decorated routes and turn each into a RawCodeStructure.
//
// v0 discovers unconditionally-declared, decorated module-level
// functions and classes (see scope.ts's doc comment for the same
// "unconditional" boundary the binder draws) and reads no further into
// a unit's body: no path-engine work happens here, so a route's
// summary carries `branches: []` (nothing declared about its response)
// or exactly one branch describing what an annotation or a decorator
// keyword already states (a FastAPI `response_model` / `status_code`,
// or a return annotation). That is the existence-class shape the
// language-adapters proposal calls for: enough to pair a route against
// a caller by method and path, nothing claimed about behavior nobody
// read.

import { dispatchByType, restBinding } from "@suss/behavioral-ir";

import {
  annotationToShape,
  collectedDefinitions,
  createAnnotationContext,
  shapeFromName,
} from "./annotations.js";
import { bodyStatements, field, rangeOf, stripDecorators } from "./ast.js";
import { classifyDecorator } from "./decorators.js";

import type { DispatchTable, TypeShape } from "@suss/behavioral-ir";
import type {
  BodyContent,
  RawBranch,
  RawCodeStructure,
  RawParameter,
} from "@suss/extractor";
import type {
  DecoratedClassRoute,
  DecoratedFunctionRoute,
  PythonDiscoveryPattern,
  PythonPack,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

export interface DiscoveryOptions {
  packs: PythonPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
}

export function discoverUnits(
  root: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const stmt of bodyStatements(root)) {
    if (stmt.type !== "decorated_definition") {
      continue;
    }
    const { definition, decorators } = stripDecorators(stmt);
    for (const decoratorNode of decorators) {
      const classification = classifyDecorator(
        decoratorNode,
        module.moduleScope,
      );
      if (classification.module === null) {
        continue;
      }
      const decoratorModule = classification.module;
      for (const pack of options.packs) {
        for (const pattern of pack.discovery) {
          units.push(
            ...unitsFor(
              pattern,
              pack,
              decoratorModule,
              classification,
              definition,
              module,
              options.filePath,
            ),
          );
        }
      }
    }
  }
  return units;
}

function unitsFor(
  pattern: PythonDiscoveryPattern,
  pack: PythonPack,
  decoratorModule: string,
  classification: ReturnType<typeof classifyDecorator>,
  definition: PyNode,
  module: ModuleBinding,
  filePath: string,
): RawCodeStructure[] {
  if (!pattern.importModule.includes(decoratorModule)) {
    return [];
  }
  // Each pattern variant owns its own shape of match (a class decorator
  // naming a path plus method-name verbs, versus a function decorator
  // whose own attribute name is the verb), so dispatch on the variant
  // rather than an if-chain repeating `pattern.type ===`.
  const table: DispatchTable<PythonDiscoveryPattern, RawCodeStructure[]> = {
    decoratedClassRoute: (p) => {
      if (
        definition.type !== "class_definition" ||
        classification.importedName !== p.decoratorName
      ) {
        return [];
      }
      return classRouteUnits(
        p,
        pack,
        classification,
        definition,
        module,
        filePath,
      );
    },
    decoratedFunctionRoute: (p) => {
      if (definition.type !== "function_definition") {
        return [];
      }
      const verb =
        classification.importedName !== null
          ? p.verbAttributeNames[classification.importedName]
          : undefined;
      if (verb === undefined) {
        return [];
      }
      return functionRouteUnits(
        p,
        pack,
        verb,
        classification,
        definition,
        module,
        filePath,
      );
    },
  };
  return dispatchByType(table, pattern);
}

function firstStringArg(
  args: ReturnType<typeof classifyDecorator>["args"],
): string | null {
  const first = args[0];
  return first?.kind === "string" ? first.value : null;
}

function classRouteUnits(
  pattern: DecoratedClassRoute,
  pack: PythonPack,
  classification: ReturnType<typeof classifyDecorator>,
  classNode: PyNode,
  module: ModuleBinding,
  filePath: string,
): RawCodeStructure[] {
  const path = firstStringArg(classification.args);
  if (path === null) {
    return [];
  }
  const className = field(classNode, "name")?.text;
  const bodyNode = field(classNode, "body");
  const classScope = module.scopeFor.get(classNode.id);
  if (
    className === undefined ||
    bodyNode === null ||
    classScope === undefined
  ) {
    return [];
  }

  const units: RawCodeStructure[] = [];
  for (const stmt of bodyStatements(bodyNode)) {
    const { definition: maybeMethod } = stripDecorators(stmt);
    if (maybeMethod.type !== "function_definition") {
      continue;
    }
    const methodName = field(maybeMethod, "name")?.text;
    const verb =
      methodName !== undefined
        ? pattern.verbMethodNames[methodName]
        : undefined;
    if (verb === undefined || methodName === undefined) {
      continue;
    }
    units.push(
      buildRouteUnit({
        pack,
        name: `${className}.${methodName}`,
        exportPath: [className, methodName],
        method: verb,
        path,
        definitionNode: maybeMethod,
        enclosingScope: classScope,
        module,
        filePath,
        skipReceiverParam: true,
        responseShape: null,
        statusCode: null,
      }),
    );
  }
  return units;
}

function functionRouteUnits(
  pattern: DecoratedFunctionRoute,
  pack: PythonPack,
  verb: string,
  classification: ReturnType<typeof classifyDecorator>,
  functionNode: PyNode,
  module: ModuleBinding,
  filePath: string,
): RawCodeStructure[] {
  const path = firstStringArg(classification.args);
  const functionName = field(functionNode, "name")?.text;
  if (path === null || functionName === undefined) {
    return [];
  }

  const ctx = createAnnotationContext(module.scopeFor);
  let responseShape: TypeShape | null = null;
  if (pattern.responseModelKeyword !== undefined) {
    const modelArg = classification.keywordArgs[pattern.responseModelKeyword];
    if (modelArg?.kind === "identifier") {
      // A response_model naming a class the binder can see resolves to
      // its record shape; one it can't (imported from elsewhere, or
      // not a class at all) stays an opaque ref by name.
      responseShape = shapeFromName(modelArg.name, module.moduleScope, ctx);
    }
  }

  let statusCode: number | null = null;
  if (pattern.statusCodeKeyword !== undefined) {
    const statusArg = classification.keywordArgs[pattern.statusCodeKeyword];
    if (statusArg?.kind === "number") {
      statusCode = statusArg.value;
    }
  }

  const unit = buildRouteUnit({
    pack,
    name: functionName,
    exportPath: [functionName],
    method: verb,
    path,
    definitionNode: functionNode,
    enclosingScope: module.moduleScope,
    module,
    filePath,
    skipReceiverParam: false,
    responseShape,
    statusCode,
    definitionsCtx: ctx,
  });
  return [unit];
}

interface BuildRouteUnitOptions {
  pack: PythonPack;
  name: string;
  exportPath: string[];
  method: string;
  path: string;
  definitionNode: PyNode;
  enclosingScope: Scope;
  module: ModuleBinding;
  filePath: string;
  skipReceiverParam: boolean;
  responseShape: TypeShape | null;
  statusCode: number | null;
  definitionsCtx?: ReturnType<typeof createAnnotationContext>;
}

function buildRouteUnit(options: BuildRouteUnitOptions): RawCodeStructure {
  const {
    pack,
    name,
    exportPath,
    method,
    path,
    definitionNode,
    enclosingScope,
    module,
    filePath,
    skipReceiverParam,
    definitionsCtx,
  } = options;

  const ctx = definitionsCtx ?? createAnnotationContext(module.scopeFor);
  const parameters = readParameters(
    definitionNode,
    enclosingScope,
    ctx,
    path,
    skipReceiverParam,
  );

  let { responseShape, statusCode } = options;
  const returnTypeNode = field(definitionNode, "return_type");
  if (responseShape === null && returnTypeNode !== null) {
    responseShape = annotationToShape(returnTypeNode, enclosingScope, ctx);
  }
  if (statusCode === null && responseShape !== null) {
    statusCode = 200;
  }

  const branches: RawBranch[] = [];
  if (responseShape !== null || statusCode !== null) {
    branches.push({
      conditions: [],
      terminal: {
        kind: "response",
        statusCode:
          statusCode !== null ? { type: "literal", value: statusCode } : null,
        body: { typeText: null, shape: responseShape },
        exceptionType: null,
        message: null,
        component: null,
        renderTree: null,
        delegateTarget: null,
        emitEvent: null,
        location: rangeOf(definitionNode),
      },
      effects: [],
      location: rangeOf(definitionNode),
      isDefault: true,
    });
  }

  const bodyNode = field(definitionNode, "body");

  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "handler",
      file: filePath,
      range: rangeOf(definitionNode),
      exportName: exportPath[0] ?? name,
      exportPath,
    },
    boundaryBinding: restBinding({
      transport: pack.protocol,
      method,
      path,
      recognition: pack.name,
    }),
    parameters,
    branches,
    bodyContent: bodyNode !== null ? bodyContentOf(bodyNode) : "statements",
    dependencyCalls: [],
    declaredContract: null,
    ...(collectedDefinitions(ctx) !== null
      ? { definitions: collectedDefinitions(ctx) }
      : {}),
  };
}

/** Whether a body holds only a docstring and/or a bare `pass`, or something more. v0 doesn't read past this: the distinction only feeds `bodyContent`, not what a transition claims. */
function bodyContentOf(bodyNode: PyNode): BodyContent {
  for (const stmt of bodyStatements(bodyNode)) {
    if (stmt.type === "pass_statement") {
      continue;
    }
    if (
      stmt.type === "expression_statement" &&
      stmt.namedChild(0)?.type === "string"
    ) {
      continue;
    }
    return "statements";
  }
  return "empty";
}

function readParameters(
  definitionNode: PyNode,
  scope: Scope,
  ctx: ReturnType<typeof createAnnotationContext>,
  path: string,
  skipReceiverParam: boolean,
): RawParameter[] {
  const parametersNode = field(definitionNode, "parameters");
  if (parametersNode === null) {
    return [];
  }
  const pathParamNames = new Set(
    Array.from(path.matchAll(/\{([A-Za-z_]\w*)\}/g)).map((m) => m[1]),
  );

  const out: RawParameter[] = [];
  let position = 0;
  for (const param of parametersNode.namedChildren) {
    if (param === null) {
      continue;
    }
    if (skipReceiverParam && position === 0 && isReceiverParam(param)) {
      position += 1;
      continue;
    }
    const parsed = readParameter(param, scope, ctx, pathParamNames, position);
    if (parsed !== null) {
      out.push(parsed);
    }
    position += 1;
  }
  return out;
}

function isReceiverParam(param: PyNode): boolean {
  return (
    param.type === "identifier" &&
    (param.text === "self" || param.text === "cls")
  );
}

function readParameter(
  param: PyNode,
  scope: Scope,
  ctx: ReturnType<typeof createAnnotationContext>,
  pathParamNames: ReadonlySet<string>,
  position: number,
): RawParameter | null {
  const info = parameterNameAndType(param);
  if (info === null) {
    return null;
  }
  const { name, typeNode } = info;
  const shape =
    typeNode !== null ? annotationToShape(typeNode, scope, ctx) : null;
  const role = roleOf(name, shape, pathParamNames);
  return {
    name,
    position,
    role,
    typeText: typeNode !== null ? typeNode.text : null,
  };
}

/**
 * A parameter named in the route path is a path parameter; a
 * parameter annotated with a locally-defined class (the only case
 * `annotationToShape` files under `def`, per `recordShapeRef`) is a
 * request body, the way a Pydantic model parameter works in FastAPI.
 * Everything else defaults to a query parameter.
 */
function roleOf(
  name: string,
  shape: TypeShape | null,
  pathParamNames: ReadonlySet<string>,
): string {
  if (pathParamNames.has(name)) {
    return "pathParams";
  }
  if (shape !== null && shape.type === "ref" && shape.def !== undefined) {
    return "requestBody";
  }
  return "queryParams";
}

function parameterNameAndType(
  param: PyNode,
): { name: string; typeNode: PyNode | null } | null {
  if (param.type === "identifier") {
    return { name: param.text, typeNode: null };
  }
  if (param.type === "typed_parameter") {
    const inner = param.namedChildren.find(
      (child) => child !== null && child.type === "identifier",
    );
    return inner !== undefined
      ? { name: inner.text, typeNode: field(param, "type") }
      : null;
  }
  if (param.type === "default_parameter") {
    const nameNode = field(param, "name");
    return nameNode?.type === "identifier"
      ? { name: nameNode.text, typeNode: null }
      : null;
  }
  if (param.type === "typed_default_parameter") {
    const nameNode = field(param, "name");
    return nameNode !== null
      ? { name: nameNode.text, typeNode: field(param, "type") }
      : null;
  }
  return null;
}
