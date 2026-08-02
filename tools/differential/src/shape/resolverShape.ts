// resolverShape.ts: how a GraphQL field says which resolver answers it.
//
// Two frameworks say it two ways. Apollo hands the server an object
// whose nesting is the schema: a type, a field, and the function under
// it. NestJS decorates a class and its methods, and the framework
// builds the same map at runtime. Either way the summary has to name
// the pair the client addresses, `typeName.fieldName`, because that
// pair is what a query pairs against.
//
// So there are two spec shapes here, one per framework, and each one's
// plainest spelling is the one its own documentation opens with.

import { type DispatchTable, dispatchByType } from "../dispatch.js";

// ---------------------------------------------------------------------------
// Apollo, where the resolvers are an object the constructor reads
// ---------------------------------------------------------------------------

/** The path the resolver map takes to the constructor argument. */
export type MapRoute =
  | "inlineLiteral"
  | "constBinding"
  | "satisfiesWrapped"
  | "asConstWrapped"
  | "spreadIntoLiteral"
  | "typeMapConst"
  | "importedMap";

/** How the resolver function under the field is written. */
export type FieldForm =
  | "arrow"
  | "asyncArrow"
  | "functionExpression"
  | "methodShorthand"
  | "namedReference";

/** The type whose field this resolver answers. */
export type FieldOwner = "Query" | "Mutation" | "Widget";

export interface ApolloResolverSpec {
  route: MapRoute;
  field: FieldForm;
  owner: FieldOwner;
}

export const APOLLO_ENTRY_FILE = "/generated/server.ts";
const APOLLO_MAP_FILE = "/generated/resolvers.ts";
const FIELD_NAME = "widget";

export const SIMPLEST_APOLLO_RESOLVER: ApolloResolverSpec = {
  route: "inlineLiteral",
  field: "arrow",
  owner: "Query",
};

/** What the oracles expect back, whichever way the program was written. */
export interface RenderedResolverShape {
  files: Record<string, string>;
  typeName: string;
  fieldName: string;
  /**
   * The name the source gives the unit, where the source gives it one.
   * Apollo writes the type and the field as the nesting of the map, so
   * `Query.widget` is what the program says. A decorated class names
   * its own class and method, and the field it answers is a decorator
   * argument, so there the binding carries the identity and the name is
   * whatever the class is called.
   */
  unitName: string | null;
}

const PARAMS = "parent: any, args: any";
const BODY = [
  "  if (args.id === undefined) {",
  '    throw new Error("id required");',
  "  }",
  '  return { id: args.id, name: "widget" };',
];

interface FieldText {
  /** Statements the map needs before it can refer to the function. */
  statements: string[];
  /** The property as it is written inside the type's map. */
  property: string;
}

const fieldTexts: DispatchTable<{ type: FieldForm }, FieldText> = {
  arrow: () => ({
    statements: [],
    property: [`${FIELD_NAME}: (${PARAMS}) => {`, ...BODY, "}"].join("\n"),
  }),
  asyncArrow: () => ({
    statements: [],
    property: [`${FIELD_NAME}: async (${PARAMS}) => {`, ...BODY, "}"].join(
      "\n",
    ),
  }),
  functionExpression: () => ({
    statements: [],
    property: [`${FIELD_NAME}: function (${PARAMS}) {`, ...BODY, "}"].join(
      "\n",
    ),
  }),
  methodShorthand: () => ({
    statements: [],
    property: [`${FIELD_NAME}(${PARAMS}) {`, ...BODY, "}"].join("\n"),
  }),
  namedReference: () => ({
    statements: [`const resolveWidget = (${PARAMS}) => {`, ...BODY, "};"],
    property: `${FIELD_NAME}: resolveWidget`,
  }),
};

interface MapRendering {
  /** Statements before the constructor call, in whichever file. */
  statements: string[];
  /** The expression the `resolvers` property is given. */
  access: string;
  extraFiles: Record<string, string>;
  imports: string[];
}

const RESOLVER_TYPE =
  "type ResolverMap = Record<string, Record<string, (...args: any[]) => unknown>>;";

function mapRenderings(
  spec: ApolloResolverSpec,
  field: FieldText,
): DispatchTable<{ type: MapRoute }, MapRendering> {
  const typeMap = `{\n  ${field.property.split("\n").join("\n  ")},\n}`;
  const wholeMap = `{\n  ${spec.owner}: ${typeMap.split("\n").join("\n  ")},\n}`;
  const bound = (suffix: string): MapRendering => ({
    statements: [
      ...field.statements,
      `const resolvers = ${wholeMap}${suffix};`,
    ],
    access: "resolvers",
    extraFiles: {},
    imports: [],
  });

  return {
    inlineLiteral: () => ({
      statements: field.statements,
      access: wholeMap,
      extraFiles: {},
      imports: [],
    }),
    constBinding: () => bound(""),
    satisfiesWrapped: () => ({
      ...bound(" satisfies ResolverMap"),
      statements: [
        RESOLVER_TYPE,
        ...field.statements,
        `const resolvers = ${wholeMap} satisfies ResolverMap;`,
      ],
    }),
    asConstWrapped: () => bound(" as ResolverMap"),
    spreadIntoLiteral: () => ({
      statements: [
        ...field.statements,
        `const ${spec.owner}Fields = ${typeMap};`,
        `const resolvers = { ${spec.owner}: { ...${spec.owner}Fields } };`,
      ],
      access: "resolvers",
      extraFiles: {},
      imports: [],
    }),
    typeMapConst: () => ({
      statements: [
        ...field.statements,
        `const ${spec.owner} = ${typeMap};`,
        `const resolvers = { ${spec.owner} };`,
      ],
      access: "resolvers",
      extraFiles: {},
      imports: [],
    }),
    importedMap: () => ({
      statements: [],
      access: "resolvers",
      extraFiles: {
        [APOLLO_MAP_FILE]: [
          ...field.statements,
          `export const resolvers = ${wholeMap};`,
          "",
        ].join("\n"),
      },
      imports: ['import { resolvers } from "./resolvers.js";'],
    }),
  };
}

export function renderApolloResolverShape(
  spec: ApolloResolverSpec,
): RenderedResolverShape {
  const field = dispatchByType(fieldTexts, { type: spec.field });
  const map = dispatchByType(mapRenderings(spec, field), { type: spec.route });
  const source = [
    'import { ApolloServer } from "@apollo/server";',
    ...map.imports,
    "",
    ...map.statements,
    "",
    `const server = new ApolloServer({ typeDefs: "", resolvers: ${map.access} });`,
    "",
    "export default server;",
    "",
  ].join("\n");

  return {
    files: { ...map.extraFiles, [APOLLO_ENTRY_FILE]: source },
    typeName: spec.owner,
    fieldName: FIELD_NAME,
    unitName: `${spec.owner}.${FIELD_NAME}`,
  };
}

// ---------------------------------------------------------------------------
// NestJS, where the class and the method carry decorators
// ---------------------------------------------------------------------------

/** How the class says it holds resolvers. */
export type ResolverAnnouncement =
  | "typeArgument"
  | "noTypeArgument"
  | "aliasedImport"
  | "wrappedDecorator"
  | "composedDecorator";

/** The operation the method answers. */
export type Operation = "Query" | "Mutation" | "ResolveField";

/** How the method itself is written. */
export type ResolverMethodForm =
  | "method"
  | "asyncMethod"
  | "arrowProperty"
  | "renamedField";

export interface NestResolverSpec {
  announcement: ResolverAnnouncement;
  operation: Operation;
  method: ResolverMethodForm;
}

export const NEST_RESOLVER_FILE = "/generated/widget.resolver.ts";
const OWNER_TYPE = "Widget";
const RENAMED_FIELD = "widgetByName";

export const SIMPLEST_NEST_RESOLVER: NestResolverSpec = {
  announcement: "typeArgument",
  operation: "Query",
  method: "method",
};

interface NestDecorator {
  preamble: string[];
  applied: string;
  /** The type the resolver's fields hang off. */
  typeName: string;
}

const GQL_IMPORT =
  'import { Args, Mutation, Query, ResolveField, Resolver } from "@nestjs/graphql";';

const nestDecorators: DispatchTable<
  { type: ResolverAnnouncement },
  NestDecorator
> = {
  typeArgument: () => ({
    preamble: [GQL_IMPORT],
    applied: `@Resolver(() => ${OWNER_TYPE})`,
    typeName: OWNER_TYPE,
  }),
  // With no type argument the class says nothing about which type it
  // resolves for, and the operation kind is the answer.
  noTypeArgument: () => ({
    preamble: [GQL_IMPORT],
    applied: "@Resolver()",
    typeName: "",
  }),
  aliasedImport: () => ({
    preamble: [
      'import { Args, Mutation, Query, ResolveField, Resolver as GraphResolver } from "@nestjs/graphql";',
    ],
    applied: `@GraphResolver(() => ${OWNER_TYPE})`,
    typeName: OWNER_TYPE,
  }),
  wrappedDecorator: () => ({
    preamble: [
      GQL_IMPORT,
      "",
      `const WidgetResolver = () => Resolver(() => ${OWNER_TYPE});`,
    ],
    applied: "@WidgetResolver()",
    typeName: OWNER_TYPE,
  }),
  composedDecorator: () => ({
    preamble: [
      'import { applyDecorators } from "@nestjs/common";',
      GQL_IMPORT,
      "",
      `const WidgetResolver = () => applyDecorators(Resolver(() => ${OWNER_TYPE}));`,
    ],
    applied: "@WidgetResolver()",
    typeName: OWNER_TYPE,
  }),
};

/** The type a field's binding names, given what the class announced. */
function resolvedTypeName(spec: NestResolverSpec, declared: string): string {
  if (declared !== "") {
    return declared;
  }
  return spec.operation === "ResolveField" ? OWNER_TYPE : spec.operation;
}

function nestMethodLines(spec: NestResolverSpec): string[] {
  const decorator =
    spec.method === "renamedField"
      ? `  @${spec.operation}(() => ${OWNER_TYPE}, { name: ${JSON.stringify(RENAMED_FIELD)} })`
      : `  @${spec.operation}(() => ${OWNER_TYPE})`;
  const signature = `@Args("id") id: string`;
  const body = [
    "    if (id === undefined) {",
    '      throw new Error("id required");',
    "    }",
    '    return { id, name: "widget" };',
  ];
  const table: DispatchTable<{ type: ResolverMethodForm }, string[]> = {
    method: () => [
      decorator,
      `  ${FIELD_NAME}(${signature}) {`,
      ...body,
      "  }",
    ],
    asyncMethod: () => [
      decorator,
      `  async ${FIELD_NAME}(${signature}) {`,
      ...body,
      "  }",
    ],
    arrowProperty: () => [
      decorator,
      `  ${FIELD_NAME} = (${signature}) => {`,
      ...body,
      "  };",
    ],
    renamedField: () => [
      decorator,
      `  ${FIELD_NAME}(${signature}) {`,
      ...body,
      "  }",
    ],
  };
  return dispatchByType(table, { type: spec.method });
}

export function renderNestResolverShape(
  spec: NestResolverSpec,
): RenderedResolverShape {
  const decorator = dispatchByType(nestDecorators, {
    type: spec.announcement,
  });
  const source = [
    ...decorator.preamble,
    "",
    "interface Widget {",
    "  id: string;",
    "  name: string;",
    "}",
    "",
    decorator.applied,
    "export class WidgetResolvers {",
    ...nestMethodLines(spec),
    "}",
    "",
  ].join("\n");

  const typeName = resolvedTypeName(spec, decorator.typeName);
  const fieldName = spec.method === "renamedField" ? RENAMED_FIELD : FIELD_NAME;
  return {
    files: { [NEST_RESOLVER_FILE]: source },
    typeName,
    fieldName,
    unitName: null,
  };
}
