// shapeProgram.ts — the DSL for how a unit is written, bound, reached,
// and announced.
//
// The handler DSL (../program.ts) varies what happens *inside* a unit.
// This one varies everything around it: the syntax the function is
// written in, the binding that holds it, the path a value takes from
// that binding to the registration site, and the shape of what the
// function hands back. Extraction has to arrive at the same summary
// however the source spells it, so a shape is rendered twice — once as
// the variant and once as a baseline that means the same thing — and
// the two summaries are compared.

import { type DispatchTable, dispatchByType } from "../dispatch.js";
import { renderBodyLines } from "../program.js";

import type { HandlerProgram, TerminalRenderer } from "../program.js";

/** How the function itself is written. */
export type FunctionForm =
  | "declaration"
  | "functionExpression"
  | "conciseArrow"
  | "blockArrow"
  | "method"
  | "asyncDeclaration"
  | "overloaded";

/** How the name that holds the function is formed. */
export type BindingForm =
  | "const"
  | "letOnce"
  | "letReassigned"
  | "var"
  | "destructured"
  | "withDefault";

/** The path a value takes from its binding to the registration site. */
export type ReachPath =
  | "direct"
  | "throughName"
  | "throughProperty"
  | "throughIndex"
  | "throughCallReturn"
  | "throughFactoryArg"
  | "throughAlias"
  | "throughParameter"
  | "throughImport"
  | "throughBarrel"
  | "throughTwoBarrels";

/** What the function hands back on top of responding. */
export type ResultShape = "respond" | "returnRespond" | "wideLibraryType";

export interface ShapeSpec {
  form: FunctionForm;
  binding: BindingForm;
  reach: ReachPath;
  result: ResultShape;
  body: HandlerProgram;
}

// The plainest spelling every other one is compared against: the
// function written where it is registered, which is the one shape a
// registration call reads today.
export const SIMPLEST_SHAPE: Omit<ShapeSpec, "body"> = {
  form: "blockArrow",
  binding: "const",
  reach: "direct",
  result: "respond",
};

export const UNIT_NAME = "handler";
export const ROUTE_PATH = "/generated";
const HANDLER_FILE = "/generated/unit.ts";
const BARREL_FILE = "/generated/barrel.ts";
const SECOND_BARREL_FILE = "/generated/secondBarrel.ts";
const WIDE_FILE = "/generated/wide.ts";
export const ENTRY_FILE = "/generated/entry.ts";

/**
 * A shape rendered into source: the files extraction reads, and the
 * bare handler the vm runs. `executable` is false for shapes whose
 * handler cannot be run in isolation (a declared library return has no
 * implementation to call).
 */
export interface RenderedShape {
  files: Record<string, string>;
  handlerSource: string;
  executable: boolean;
}

/** What a target contributes: response syntax and the registration form. */
export interface ShapeSyntax {
  renderTerminal: TerminalRenderer;
  /** Import lines and the statements that create the router/app. */
  preamble: string[];
  /** `router.get("/generated", <access>)` for the given access expression. */
  renderRegistration: (access: string) => string;
  /**
   * Responding with a value the pack has to read a type for, rather
   * than an object literal it can read directly.
   */
  renderTypedResponse: (expression: string) => string;
  /** Trailing statements, usually the router export. */
  epilogue: string[];
}

// ---------------------------------------------------------------------------
// Constraints — which combinations mean anything
// ---------------------------------------------------------------------------

/** Forms whose function is a statement, so the binding only re-names it. */
const DECLARED_FORMS = new Set<FunctionForm>([
  "declaration",
  "asyncDeclaration",
  "overloaded",
  "method",
]);

/**
 * A concise arrow has one expression for a body, and a function that
 * goes straight into the registration call never gets a binding to be
 * reached through. The generator only produces valid shapes; this
 * predicate says which those are, and the tests hold it.
 */
export function isValidShape(spec: ShapeSpec): boolean {
  if (spec.form === "conciseArrow") {
    return (
      spec.body.guards.length === 0 &&
      spec.body.final.type === "respond" &&
      spec.result !== "wideLibraryType"
    );
  }
  if (spec.reach === "direct") {
    return !DECLARED_FORMS.has(spec.form);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering the function itself
// ---------------------------------------------------------------------------

const PARAMS = "req: any, res: any";

function bodyLines(spec: ShapeSpec, syntax: ShapeSyntax): string[] {
  const lines = renderBodyLines(spec.body, syntax.renderTerminal);
  if (spec.result === "wideLibraryType") {
    return [
      ...lines.slice(0, -1),
      `${syntax.renderTypedResponse("describe()")};`,
    ];
  }
  if (spec.result === "returnRespond" && lines.length > 0) {
    const last = lines[lines.length - 1];
    return last.startsWith("res.") || last.startsWith("reply.")
      ? [...lines.slice(0, -1), `return ${last}`]
      : lines;
  }
  return lines;
}

const indentBy = (lines: string[], by: string): string[] =>
  lines.map((line) => `${by}${line}`);

/** The single expression a concise arrow's body is. */
function conciseExpression(spec: ShapeSpec, syntax: ShapeSyntax): string {
  const final = spec.body.final;
  if (final.type !== "respond") {
    throw new Error("concise arrow bodies are a single respond");
  }
  return syntax.renderTerminal(final.terminal);
}

interface FunctionText {
  /** Statements that must precede the binding (declarations, overloads). */
  statements: string[];
  /** The expression that evaluates to the function, when there is one. */
  expression: string | null;
}

function functionTexts(
  spec: ShapeSpec,
  syntax: ShapeSyntax,
): DispatchTable<{ type: FunctionForm }, FunctionText> {
  const lines = () => indentBy(bodyLines(spec, syntax), "  ");
  return {
    declaration: () => ({
      statements: [`function ${UNIT_NAME}Impl(${PARAMS}) {`, ...lines(), "}"],
      expression: `${UNIT_NAME}Impl`,
    }),
    asyncDeclaration: () => ({
      statements: [
        `async function ${UNIT_NAME}Impl(${PARAMS}) {`,
        ...lines(),
        "}",
      ],
      expression: `${UNIT_NAME}Impl`,
    }),
    overloaded: () => ({
      statements: [
        `function ${UNIT_NAME}Impl(${PARAMS}): void;`,
        `function ${UNIT_NAME}Impl(${PARAMS}): void {`,
        ...lines(),
        "}",
      ],
      expression: `${UNIT_NAME}Impl`,
    }),
    functionExpression: () => ({
      statements: [],
      expression: [`function (${PARAMS}) {`, ...lines(), "}"].join("\n"),
    }),
    blockArrow: () => ({
      statements: [],
      expression: [`(${PARAMS}) => {`, ...lines(), "}"].join("\n"),
    }),
    conciseArrow: () => ({
      statements: [],
      expression: `(${PARAMS}) => ${conciseExpression(spec, syntax)}`,
    }),
    method: () => ({
      statements: [
        "const methods = {",
        `  ${UNIT_NAME}(${PARAMS}) {`,
        ...indentBy(lines(), "  "),
        "  },",
        "};",
      ],
      expression: `methods.${UNIT_NAME}`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Rendering the binding
// ---------------------------------------------------------------------------

/**
 * A second handler that responds differently, so a reassigned binding
 * can be told apart from its first assignment by execution alone.
 */
const DISPLACED_HANDLER = `(req: any, res: any) => { res.status(418).json({ ok: "displaced" }); }`;

function bindingStatements(
  binding: BindingForm,
  name: string,
  expression: string,
): string[] {
  const table: DispatchTable<{ type: BindingForm }, string[]> = {
    const: () => [`const ${name} = ${expression};`],
    letOnce: () => [`let ${name} = ${expression};`],
    letReassigned: () => [
      `let ${name} = ${DISPLACED_HANDLER};`,
      `${name} = ${expression};`,
    ],
    var: () => [`var ${name} = ${expression};`],
    destructured: () => [`const { ${name} } = { ${name}: ${expression} };`],
    withDefault: () => [
      `const holder: { ${name}?: any } = {};`,
      `const { ${name} = ${expression} } = holder;`,
    ],
  };
  return dispatchByType(table, { type: binding });
}

// ---------------------------------------------------------------------------
// Rendering the reach
// ---------------------------------------------------------------------------

interface ReachRendering {
  /** Statements in the entry file, after the binding. */
  statements: string[];
  /** The registration call, and whatever wraps it. */
  registration: (syntax: ShapeSyntax) => string[];
  /** Extra files (the unit's own file, barrels). */
  extraFiles: Record<string, string>;
  /** Import lines the entry file needs. */
  imports: string[];
  /** Whether the binding is declared in the entry file at all. */
  bindsInEntry: boolean;
}

const BOUND = UNIT_NAME;

function reachRenderings(
  spec: ShapeSpec,
  fn: FunctionText,
): DispatchTable<{ type: ReachPath }, ReachRendering> {
  const local = (statements: string[], access: string): ReachRendering => ({
    statements,
    registration: (syntax) => [syntax.renderRegistration(access)],
    extraFiles: {},
    imports: [],
    bindsInEntry: true,
  });
  const unitFile = (): string =>
    [
      ...fn.statements,
      ...(fn.expression === null
        ? []
        : bindingStatements(spec.binding, BOUND, fn.expression)),
      `export { ${BOUND} };`,
      "",
    ].join("\n");

  return {
    direct: () => local([], fn.expression ?? BOUND),
    throughName: () => local([], BOUND),
    throughProperty: () =>
      local([`const routes = { list: ${BOUND} };`], "routes.list"),
    throughIndex: () => local([`const routes = [${BOUND}];`], "routes[0]"),
    throughCallReturn: () => local([`const pick = () => ${BOUND};`], "pick()"),
    throughFactoryArg: () =>
      local(
        [
          "const build = (options: { handle: any }) => options.handle;",
          `const built = build({ handle: ${BOUND} });`,
        ],
        "built",
      ),
    throughAlias: () => local([`const alias = ${BOUND};`], "alias"),
    throughParameter: () => ({
      statements: [],
      registration: (syntax) => [
        "const register = (handle: any) => {",
        `  ${syntax.renderRegistration("handle")}`,
        "};",
        `register(${BOUND});`,
      ],
      extraFiles: {},
      imports: [],
      bindsInEntry: true,
    }),
    throughImport: () => ({
      ...imported(unitFile(), {}),
      imports: [`import { ${BOUND} } from "./unit.js";`],
    }),
    throughBarrel: () => ({
      ...imported(unitFile(), {
        [BARREL_FILE]: `export { ${BOUND} } from "./unit.js";\n`,
      }),
      imports: [`import { ${BOUND} } from "./barrel.js";`],
    }),
    throughTwoBarrels: () => ({
      ...imported(unitFile(), {
        [BARREL_FILE]: `export { ${BOUND} } from "./unit.js";\n`,
        [SECOND_BARREL_FILE]: `export { ${BOUND} } from "./unit.js";\n`,
      }),
      imports: [`import { ${BOUND} } from "./secondBarrel.js";`],
    }),
  };
}

const imported = (
  unitSource: string,
  barrels: Record<string, string>,
): ReachRendering => ({
  statements: [],
  registration: (syntax) => [syntax.renderRegistration(BOUND)],
  extraFiles: { [HANDLER_FILE]: unitSource, ...barrels },
  imports: [],
  bindsInEntry: false,
});

// ---------------------------------------------------------------------------
// The wide library type — a type whose breadth, not depth, is the risk
// ---------------------------------------------------------------------------

export interface WideTypeSize {
  width: number;
  depth: number;
}

export function renderWideTypeModule(size: WideTypeSize): string {
  const levels: string[] = [];
  for (let level = 0; level < size.depth; level++) {
    const child = level + 1 === size.depth ? "string" : `Level${level + 1}`;
    const fields = Array.from(
      { length: size.width },
      (_unused, index) => `  field${index}: ${child};`,
    );
    levels.push(`export interface Level${level} {`, ...fields, "}", "");
  }
  levels.push("export declare function describe(): Level0;", "");
  return levels.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering a whole shape
// ---------------------------------------------------------------------------

export interface RenderShapeOptions {
  spec: ShapeSpec;
  syntax: ShapeSyntax;
  wideType: WideTypeSize;
}

export function renderShape(options: RenderShapeOptions): RenderedShape {
  const { spec, syntax } = options;
  const fn = dispatchByType(functionTexts(spec, syntax), { type: spec.form });
  const reach = dispatchByType(reachRenderings(spec, fn), { type: spec.reach });

  const bindingLines =
    reach.bindsInEntry && spec.reach !== "direct" && fn.expression !== null
      ? bindingStatements(spec.binding, BOUND, fn.expression)
      : [];
  const declarationLines = reach.bindsInEntry ? fn.statements : [];

  const wideImport =
    spec.result === "wideLibraryType"
      ? [`import { describe } from "./wide.js";`]
      : [];

  const entry = [
    ...syntax.preamble,
    ...reach.imports,
    ...wideImport,
    "",
    ...declarationLines,
    ...bindingLines,
    ...reach.statements,
    "",
    ...reach.registration(syntax),
    "",
    ...syntax.epilogue,
    "",
  ].join("\n");

  const files: Record<string, string> = {
    ...reach.extraFiles,
    [ENTRY_FILE]: entry,
  };
  if (spec.result === "wideLibraryType") {
    files[WIDE_FILE] = renderWideTypeModule(options.wideType);
  }

  return {
    files,
    handlerSource: renderExecutableHandler(spec, syntax),
    executable: spec.result !== "wideLibraryType",
  };
}

/**
 * The bare arrow the vm runs. Every shape of one body means the same
 * run, so execution reads the body alone — with one exception that is
 * the point: a reassigned binding runs its *final* value, which is what
 * makes the first-assignment claim falsifiable.
 */
function renderExecutableHandler(spec: ShapeSpec, syntax: ShapeSyntax): string {
  const body = indentBy(bodyLines(spec, syntax), "  ").join("\n");
  return `(req, res) => {\n${body}\n}`;
}
