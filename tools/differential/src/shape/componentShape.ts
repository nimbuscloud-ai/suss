// componentShape.ts — the same dimensions at the render boundary.
//
// The HTTP registration call reads the function literal handed to it,
// so the shapes it can express stop at the call's last argument.
// Export-based discovery follows names, and a name is where the space
// opens up: the component can be written six ways, bound six ways, and
// exported ten ways, and every combination should arrive at one summary
// that says the same thing.

import { type DispatchTable, dispatchByType } from "../dispatch.js";
import {
  componentBodyLines,
  renderComponentParams,
  renderPropsInterface,
} from "../jsx/componentProgram.js";

import type { ComponentProgram } from "../jsx/componentProgram.js";
import type { BindingForm } from "./shapeProgram.js";

/** How the component function is written. */
export type ComponentForm =
  | "declaration"
  | "functionExpression"
  | "conciseArrow"
  | "blockArrow"
  | "asyncDeclaration"
  | "overloaded"
  | "method";

/** How the component reaches the module's export surface. */
export type ExportRoute =
  | "namedDeclaration"
  | "namedBinding"
  | "defaultDeclaration"
  | "defaultOfName"
  | "namedAndDefault"
  | "aliasedNamed"
  | "throughProperty"
  | "throughFactoryArg"
  | "barrel"
  | "twoBarrels";

export interface ComponentShapeSpec {
  form: ComponentForm;
  binding: BindingForm;
  route: ExportRoute;
  body: ComponentProgram;
}

export const COMPONENT_NAME = "Panel";
const ALIAS_NAME = "PanelView";
const COMPONENT_FILE = "/generated/Panel.tsx";
const BARREL_FILE = "/generated/barrel.ts";
const SECOND_BARREL_FILE = "/generated/secondBarrel.ts";

// The plainest spelling every other one is compared against. The route
// binds the component to a name before exporting it, so that the
// binding dimension has somewhere to show up: a component written where
// it is exported has no binding at all.
export const SIMPLEST_COMPONENT_SHAPE: Omit<ComponentShapeSpec, "body"> = {
  form: "declaration",
  binding: "const",
  route: "namedBinding",
};

/**
 * Routes that rename what they export. The exported name is then a
 * defensible answer for the summary's name as well as the source name,
 * so the "a named unit keeps its name" invariant sits those out.
 */
export const RENAMING_ROUTES = new Set<ExportRoute>(["aliasedNamed"]);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface ComponentText {
  /** Statements the function needs before anything can refer to it. */
  statements: string[];
  /** The expression that evaluates to the component. */
  expression: string;
  /** The name the function carries in source, when it carries one. */
  sourceName: string | null;
  /**
   * The function written as its own export, when the form allows it
   * (`export function Panel() {}`, `export const Panel = () => …`). A
   * method has to sit in an object literal, so it has none.
   */
  inlineExport: string[] | null;
}

const IMPL = `${COMPONENT_NAME}Impl`;

function componentTexts(
  program: ComponentProgram,
): DispatchTable<{ type: ComponentForm }, ComponentText> {
  const params = renderComponentParams(program);
  const lines = componentBodyLines(program).map((line) => `  ${line}`);
  const concise = componentBodyLines(program)
    .filter((line) => line.startsWith("return "))
    .map((line) => line.slice("return ".length).replace(/;$/, ""))[0];
  const functionExpression = [`function (${params}) {`, ...lines, "}"].join(
    "\n",
  );
  const blockArrow = [`(${params}) => {`, ...lines, "}"].join("\n");
  const conciseArrow = `(${params}) => (${concise})`;

  return {
    declaration: () => ({
      statements: [`function ${IMPL}(${params}) {`, ...lines, "}"],
      expression: IMPL,
      sourceName: IMPL,
      inlineExport: [
        `export function ${COMPONENT_NAME}(${params}) {`,
        ...lines,
        "}",
      ],
    }),
    asyncDeclaration: () => ({
      statements: [`async function ${IMPL}(${params}) {`, ...lines, "}"],
      expression: IMPL,
      sourceName: IMPL,
      inlineExport: [
        `export async function ${COMPONENT_NAME}(${params}) {`,
        ...lines,
        "}",
      ],
    }),
    overloaded: () => ({
      statements: [
        `function ${IMPL}(${params}): any;`,
        `function ${IMPL}(${params}): any {`,
        ...lines,
        "}",
      ],
      expression: IMPL,
      sourceName: IMPL,
      inlineExport: [
        `export function ${COMPONENT_NAME}(${params}): any;`,
        `export function ${COMPONENT_NAME}(${params}): any {`,
        ...lines,
        "}",
      ],
    }),
    functionExpression: () => ({
      statements: [],
      expression: functionExpression,
      sourceName: null,
      inlineExport: [`export const ${COMPONENT_NAME} = ${functionExpression};`],
    }),
    blockArrow: () => ({
      statements: [],
      expression: blockArrow,
      sourceName: null,
      inlineExport: [`export const ${COMPONENT_NAME} = ${blockArrow};`],
    }),
    conciseArrow: () => ({
      statements: [],
      expression: conciseArrow,
      sourceName: null,
      inlineExport: [`export const ${COMPONENT_NAME} = ${conciseArrow};`],
    }),
    method: () => ({
      statements: [
        "const parts = {",
        `  ${COMPONENT_NAME}(${params}) {`,
        ...lines.map((line) => `  ${line}`),
        "  },",
        "};",
      ],
      expression: `parts.${COMPONENT_NAME}`,
      sourceName: COMPONENT_NAME,
      inlineExport: null,
    }),
  };
}

/**
 * A concise arrow's body is one expression, so a component written that
 * way cannot hold guards. The generator drops them rather than skipping
 * the draw.
 */
export function repairComponentShape(
  spec: ComponentShapeSpec,
): ComponentShapeSpec {
  if (spec.form !== "conciseArrow") {
    return spec;
  }
  return { ...spec, body: { ...spec.body, guards: [] } };
}

function bindingStatements(
  binding: BindingForm,
  name: string,
  expression: string,
): string[] {
  const displaced = "() => <span/>";
  const table: DispatchTable<{ type: BindingForm }, string[]> = {
    const: () => [`const ${name} = ${expression};`],
    letOnce: () => [`let ${name} = ${expression};`],
    letReassigned: () => [
      `let ${name} = ${displaced};`,
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

export interface RenderedComponentShape {
  files: Record<string, string>;
  /** The name a summary should carry, when the route does not rename. */
  expectedName: string | null;
}

interface RouteRendering {
  /** Statements after the binding, in the component's own file. */
  statements: string[];
  /** Export statements in the component's own file. */
  exports: string[];
  /**
   * Whether the component is bound to the name `Panel` before it is
   * exported. A route that exports the function where it is written
   * has no binding, so the binding dimension does not apply and the
   * name a summary should carry is the function's own.
   */
  bindsName: boolean;
  extraFiles: Record<string, string>;
}

function routeRenderings(
  component: ComponentText,
): DispatchTable<{ type: ExportRoute }, RouteRendering> {
  const plain = (
    exports: string[],
    statements: string[] = [],
  ): RouteRendering => ({
    statements,
    exports,
    bindsName: true,
    extraFiles: {},
  });
  const barrels = (files: Record<string, string>): RouteRendering => ({
    statements: [],
    exports: [`export { ${COMPONENT_NAME} };`],
    bindsName: true,
    extraFiles: files,
  });

  return {
    // The function is written where it is exported, which is how most
    // components in a codebase are spelled.
    namedDeclaration: () =>
      component.inlineExport === null
        ? plain([`export { ${COMPONENT_NAME} };`])
        : {
            statements: [],
            exports: component.inlineExport,
            bindsName: false,
            extraFiles: {},
          },
    namedBinding: () => plain([`export { ${COMPONENT_NAME} };`]),
    defaultDeclaration: () => ({
      statements: [],
      exports: [`export default ${component.expression};`],
      bindsName: false,
      extraFiles: {},
    }),
    defaultOfName: () => plain([`export default ${COMPONENT_NAME};`]),
    namedAndDefault: () =>
      plain([
        `export { ${COMPONENT_NAME} };`,
        `export default ${COMPONENT_NAME};`,
      ]),
    aliasedNamed: () =>
      plain([`export { ${COMPONENT_NAME} as ${ALIAS_NAME} };`]),
    throughProperty: () =>
      plain(
        [`export default views.${COMPONENT_NAME};`],
        [`const views = { ${COMPONENT_NAME} };`],
      ),
    throughFactoryArg: () =>
      plain(
        ["export default built;"],
        [
          "const build = (options: { render: any }) => options.render;",
          `const built = build({ render: ${COMPONENT_NAME} });`,
        ],
      ),
    barrel: () =>
      barrels({
        [BARREL_FILE]: `export { ${COMPONENT_NAME} } from "./Panel.js";\n`,
      }),
    twoBarrels: () =>
      barrels({
        [BARREL_FILE]: `export { ${COMPONENT_NAME} } from "./Panel.js";\n`,
        [SECOND_BARREL_FILE]: `export { ${COMPONENT_NAME} } from "./Panel.js";\n`,
      }),
  };
}

export function renderComponentShape(
  spec: ComponentShapeSpec,
): RenderedComponentShape {
  const component = dispatchByType(componentTexts(spec.body), {
    type: spec.form,
  });
  const route = dispatchByType(routeRenderings(component), {
    type: spec.route,
  });

  const binding = route.bindsName
    ? bindingStatements(spec.binding, COMPONENT_NAME, component.expression)
    : [];
  const usesInlineExport = route.exports === component.inlineExport;

  const source = [
    renderPropsInterface(spec.body),
    "",
    ...(usesInlineExport ? [] : component.statements),
    ...binding,
    ...route.statements,
    "",
    ...route.exports,
    "",
  ].join("\n");

  return {
    files: { [COMPONENT_FILE]: source, ...route.extraFiles },
    expectedName: expectedNameOf(spec, route, component),
  };
}

function expectedNameOf(
  spec: ComponentShapeSpec,
  route: RouteRendering,
  component: ComponentText,
): string | null {
  if (RENAMING_ROUTES.has(spec.route)) {
    return null;
  }
  if (route.bindsName) {
    return COMPONENT_NAME;
  }
  return route.exports === component.inlineExport
    ? COMPONENT_NAME
    : component.sourceName;
}
