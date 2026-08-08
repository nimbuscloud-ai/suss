// announceShape.ts: how a boundary says that it is one.
//
// Express hands a function to a call and React exports a name. NestJS
// does neither: the class has a decorator, the method has
// another, and the framework wires them. Codebases then wrap those
// decorators in their own, which is the dimension this generates. A
// project decorator that calls the framework's is still the framework's
// decorator, and the boundary is still there.

import { type DispatchTable, dispatchByType } from "../dispatch.js";

export type Announcement =
  | "bareDecorator"
  | "aliasedImport"
  | "wrappedDecorator"
  | "wrappedWithArgument"
  | "composedDecorator";

export type MethodForm = "method" | "asyncMethod" | "arrowProperty";

export interface AnnounceShapeSpec {
  announcement: Announcement;
  method: MethodForm;
  /** The one thing the handler returns, so summaries are comparable. */
  bodyKey: string;
}

export const ANNOUNCEMENTS: Announcement[] = [
  "bareDecorator",
  "aliasedImport",
  "wrappedDecorator",
  "wrappedWithArgument",
  "composedDecorator",
];

export const SIMPLEST_ANNOUNCEMENT: Omit<AnnounceShapeSpec, "bodyKey"> = {
  announcement: "bareDecorator",
  method: "method",
};

export const CONTROLLER_FILE = "/generated/generated.controller.ts";
const ROUTE_PREFIX = "/generated";

interface DecoratorRendering {
  /** Import line from the framework, plus whatever the project defines. */
  preamble: string[];
  /** The decorator written above the class. */
  applied: string;
}

const NEST_IMPORT = 'import { Controller, Get } from "@nestjs/common";';

const decoratorRenderings: DispatchTable<
  { type: Announcement },
  DecoratorRendering
> = {
  bareDecorator: () => ({
    preamble: [NEST_IMPORT],
    applied: `@Controller(${JSON.stringify(ROUTE_PREFIX)})`,
  }),
  // The same decorator under another name, which is what a project does
  // when the framework's name collides with one of its own.
  aliasedImport: () => ({
    preamble: ['import { Controller as Resource, Get } from "@nestjs/common";'],
    applied: `@Resource(${JSON.stringify(ROUTE_PREFIX)})`,
  }),
  // A project decorator that calls the framework's and adds nothing.
  wrappedDecorator: () => ({
    preamble: [
      NEST_IMPORT,
      "",
      `const Section = () => Controller(${JSON.stringify(ROUTE_PREFIX)});`,
    ],
    applied: "@Section()",
  }),
  // The same, with the path handed through the project's decorator.
  wrappedWithArgument: () => ({
    preamble: [
      NEST_IMPORT,
      "",
      "const Section = (path: string) => Controller(path);",
    ],
    applied: `@Section(${JSON.stringify(ROUTE_PREFIX)})`,
  }),
  // The framework's own composition helper, which is how NestJS itself
  // tells projects to combine decorators.
  composedDecorator: () => ({
    preamble: [
      'import { applyDecorators, Controller, Get } from "@nestjs/common";',
      "",
      `const Section = () => applyDecorators(Controller(${JSON.stringify(ROUTE_PREFIX)}));`,
    ],
    applied: "@Section()",
  }),
};

function methodLines(spec: AnnounceShapeSpec): string[] {
  const returns = `return { ${spec.bodyKey}: "yes" };`;
  const table: DispatchTable<{ type: MethodForm }, string[]> = {
    method: () => ["  @Get()", "  list() {", `    ${returns}`, "  }"],
    asyncMethod: () => [
      "  @Get()",
      "  async list() {",
      `    ${returns}`,
      "  }",
    ],
    arrowProperty: () => [
      "  @Get()",
      "  list = () => {",
      `    ${returns}`,
      "  };",
    ],
  };
  return dispatchByType(table, { type: spec.method });
}

export function renderAnnounceShape(
  spec: AnnounceShapeSpec,
): Record<string, string> {
  const decorator = dispatchByType(decoratorRenderings, {
    type: spec.announcement,
  });
  const source = [
    ...decorator.preamble,
    "",
    decorator.applied,
    "export class GeneratedController {",
    ...methodLines(spec),
    "}",
    "",
  ].join("\n");
  return { [CONTROLLER_FILE]: source };
}
