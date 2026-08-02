// shapeGenerators.ts: fast-check arbitraries over the shape
// dimensions.
//
// Each dimension is drawn independently and the combination is repaired
// into a valid one, rather than enumerating the combinations that make
// sense. A dimension added here reaches every other dimension's values
// on the next run, which is the point of generating the space instead
// of listing the cases found so far.

import fc from "fast-check";

import { arbHandlerProgram, SOUND_TIER } from "../generators.js";
import { arbComponentProgram } from "../jsx/componentGenerators.js";
import {
  type ComponentForm,
  type ComponentShapeSpec,
  type ExportRoute,
  repairComponentShape,
} from "./componentShape.js";
import {
  type BindingForm,
  type FunctionForm,
  isValidShape,
  type ReachPath,
  type ResultShape,
  type ShapeSpec,
} from "./shapeProgram.js";

import type { HandlerProgram } from "../program.js";
import type { EnvShapeSpec, ReadForm, ReadSite } from "./envShape.js";
import type {
  ImportForm,
  PackageShapeSpec,
  PublishRoute,
} from "./packageShape.js";
import type {
  ConfigStyle,
  ConsumerBuild,
  QueueShapeSpec,
} from "./queueShape.js";
import type {
  ApolloResolverSpec,
  FieldForm,
  FieldOwner,
  MapRoute,
  NestResolverSpec,
  Operation,
  ResolverAnnouncement,
  ResolverMethodForm,
} from "./resolverShape.js";

export const FUNCTION_FORMS: FunctionForm[] = [
  "declaration",
  "functionExpression",
  "conciseArrow",
  "blockArrow",
  "method",
  "asyncDeclaration",
  "overloaded",
];

export const BINDING_FORMS: BindingForm[] = [
  "const",
  "letOnce",
  "letReassigned",
  "var",
  "destructured",
  "withDefault",
];

export const REACH_PATHS: ReachPath[] = [
  "direct",
  "throughName",
  "throughProperty",
  "throughIndex",
  "throughCallReturn",
  "throughFactoryArg",
  "throughAlias",
  "throughParameter",
  "throughImport",
  "throughBarrel",
  "throughTwoBarrels",
];

export const RESULT_SHAPES: ResultShape[] = ["respond", "returnRespond"];

/**
 * Repair rather than reject: a shape whose dimensions do not fit gets
 * the nearest one changed, so no draw is thrown away and per-dimension
 * coverage stays close to uniform. A concise arrow keeps the response
 * its body ends on and drops the guards it cannot hold; a form written
 * as a statement cannot go straight into the registration call, so the
 * form gives way to the arrow that can.
 */
export function repairShape(spec: ShapeSpec): ShapeSpec {
  if (spec.form === "conciseArrow") {
    return {
      ...spec,
      result: spec.result === "wideNamedType" ? "respond" : spec.result,
      body: { guards: [], final: singleResponse(spec.body) },
    };
  }
  if (spec.reach === "direct") {
    return { ...spec, form: "blockArrow" };
  }
  return spec;
}

const singleResponse = (body: HandlerProgram): HandlerProgram["final"] =>
  body.final.type === "respond"
    ? body.final
    : { type: "respond", terminal: body.final.whenTrue };

export const arbShapeSpec: fc.Arbitrary<ShapeSpec> = fc
  .record({
    form: fc.constantFrom(...FUNCTION_FORMS),
    binding: fc.constantFrom(...BINDING_FORMS),
    reach: fc.constantFrom(...REACH_PATHS),
    result: fc.constantFrom(...RESULT_SHAPES),
    body: arbHandlerProgram(SOUND_TIER),
  })
  .map(repairShape)
  .filter(isValidShape);

// ---------------------------------------------------------------------------
// The render boundary
// ---------------------------------------------------------------------------

export const COMPONENT_FORMS: ComponentForm[] = [
  "declaration",
  "functionExpression",
  "conciseArrow",
  "blockArrow",
  "asyncDeclaration",
  "overloaded",
  "method",
];

export const EXPORT_ROUTES: ExportRoute[] = [
  "namedDeclaration",
  "namedBinding",
  "defaultDeclaration",
  "defaultOfName",
  "namedAndDefault",
  "aliasedNamed",
  "throughProperty",
  "throughFactoryArg",
  "barrel",
  "twoBarrels",
];

export const arbComponentShapeSpec: fc.Arbitrary<ComponentShapeSpec> = fc
  .record({
    form: fc.constantFrom(...COMPONENT_FORMS),
    binding: fc.constantFrom(...BINDING_FORMS),
    route: fc.constantFrom(...EXPORT_ROUTES),
    body: arbComponentProgram,
  })
  .map(repairComponentShape);

export function arbComponentShapeWith(
  fixed: Partial<ComponentShapeSpec>,
): fc.Arbitrary<ComponentShapeSpec> {
  return arbComponentShapeSpec.map((spec) =>
    repairComponentShape({ ...spec, ...fixed }),
  );
}

// ---------------------------------------------------------------------------
// Package exports
// ---------------------------------------------------------------------------

export const PUBLISH_ROUTES: PublishRoute[] = [
  "namedFunction",
  "exportedArrow",
  "reexportedFromModule",
  "renamedExport",
  "starReexport",
  "subPathExport",
  "mainOnly",
];

export const IMPORT_FORMS: ImportForm[] = [
  "namedImport",
  "aliasedImport",
  "namespaceImport",
  "throughLocalBinding",
  "reexportedByConsumer",
];

export const arbPackageShapeSpec: fc.Arbitrary<PackageShapeSpec> = fc.record({
  route: fc.constantFrom(...PUBLISH_ROUTES),
  form: fc.constantFrom(...IMPORT_FORMS),
});

// ---------------------------------------------------------------------------
// Queue consumers
// ---------------------------------------------------------------------------

export const CONSUMER_BUILDS: ConsumerBuild[] = [
  "factoryConfigFirst",
  "factoryConfigSecond",
  "configThroughVariable",
  "spreadIntoConfig",
  "asConstSubject",
  "factoryThroughAlias",
  "subjectFromConst",
  "subjectFromSharedMap",
  "spreadCarriesSubject",
  "wrappedFactoryResult",
  "reexportedHandler",
  "bareFunction",
];

export const CONFIG_STYLES: ConfigStyle[] = [
  "propertyOnly",
  "namedCallee",
  "argIndexed",
];

export const arbQueueShapeSpec: fc.Arbitrary<QueueShapeSpec> = fc.record({
  build: fc.constantFrom(...CONSUMER_BUILDS),
  config: fc.constantFrom(...CONFIG_STYLES),
});

// ---------------------------------------------------------------------------
// GraphQL resolvers
// ---------------------------------------------------------------------------

export const MAP_ROUTES: MapRoute[] = [
  "inlineLiteral",
  "constBinding",
  "satisfiesWrapped",
  "asConstWrapped",
  "spreadIntoLiteral",
  "typeMapConst",
  "importedMap",
];

export const FIELD_FORMS: FieldForm[] = [
  "arrow",
  "asyncArrow",
  "functionExpression",
  "methodShorthand",
  "namedReference",
];

export const FIELD_OWNERS: FieldOwner[] = ["Query", "Mutation", "Widget"];

export const arbApolloResolverSpec: fc.Arbitrary<ApolloResolverSpec> =
  fc.record({
    route: fc.constantFrom(...MAP_ROUTES),
    field: fc.constantFrom(...FIELD_FORMS),
    owner: fc.constantFrom(...FIELD_OWNERS),
  });

export const RESOLVER_ANNOUNCEMENTS: ResolverAnnouncement[] = [
  "typeArgument",
  "noTypeArgument",
  "aliasedImport",
  "wrappedDecorator",
  "composedDecorator",
];

export const OPERATIONS: Operation[] = ["Query", "Mutation", "ResolveField"];

export const RESOLVER_METHOD_FORMS: ResolverMethodForm[] = [
  "method",
  "asyncMethod",
  "arrowProperty",
  "renamedField",
];

export const arbNestResolverSpec: fc.Arbitrary<NestResolverSpec> = fc.record({
  announcement: fc.constantFrom(...RESOLVER_ANNOUNCEMENTS),
  operation: fc.constantFrom(...OPERATIONS),
  method: fc.constantFrom(...RESOLVER_METHOD_FORMS),
});

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

export const READ_SITES: ReadSite[] = [
  "inBody",
  "inGuard",
  "inNestedArrow",
  "inLocalHelper",
  "inImportedHelper",
  "atModuleScope",
];

export const READ_FORMS: ReadForm[] = [
  "dotted",
  "bracket",
  "defaulted",
  "destructured",
];

// Names a service would give its own variables. The name is not a
// dimension, so a handful is enough to keep one hard-coded string from
// being what makes a read resolve.
const VAR_NAMES = ["SERVICE_URL", "API_TOKEN", "TABLE_NAME", "LOG_LEVEL"];

export const arbEnvShapeSpec: fc.Arbitrary<EnvShapeSpec> = fc.record({
  site: fc.constantFrom(...READ_SITES),
  form: fc.constantFrom(...READ_FORMS),
  varName: fc.constantFrom(...VAR_NAMES),
});

export function arbEnvShapeWith(
  fixed: Partial<EnvShapeSpec>,
): fc.Arbitrary<EnvShapeSpec> {
  return arbEnvShapeSpec.map((spec) => ({ ...spec, ...fixed }));
}

/** A shape that forces one dimension's value, for a targeted property. */
export function arbShapeWith(
  fixed: Partial<ShapeSpec>,
): fc.Arbitrary<ShapeSpec> {
  return arbShapeSpec
    .map((spec) => repairShape({ ...spec, ...fixed }))
    .filter(isValidShape);
}
