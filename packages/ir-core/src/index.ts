// @suss/ir-core — primitives shared across suss IRs.
//
// Types are derived from the schemas (single source of truth): each
// boundary protocol's schema and behavior live in one module under
// `./semantics`, and the rest in `./schemas`. The boundary-binding
// constructors live here too so every package that produces an IR
// object — pattern packs, contract readers, intent docs, tests — can
// build a binding without depending on a specific IR.

import type { z } from "zod";
import type {
  BoundaryBindingSchema,
  ConfidenceInfoSchema,
  ConfidenceLevelSchema,
  ConfidenceSourceSchema,
  CorroborationSchema,
  SourceLocationSchema,
} from "./schemas.js";

export {
  BoundaryBindingSchema,
  ConfidenceInfoSchema,
  ConfidenceLevelSchema,
  ConfidenceSourceSchema,
  CorroborationSchema,
  DeployableUnitSchema,
  SourceLocationSchema,
  TypeShapeSchema,
  typeDefinitionKey,
  withDefinitionsInlined,
} from "./schemas.js";
export { FunctionCallSemanticsSchema } from "./semantics/functionCall.js";
export { GraphqlOperationSemanticsSchema } from "./semantics/graphqlOperation.js";
export { GraphqlResolverSemanticsSchema } from "./semantics/graphqlResolver.js";
export { MessageBusSemanticsSchema } from "./semantics/messageBus.js";
export { SemanticsSchema } from "./semantics/registry.js";
export { RestSemanticsSchema } from "./semantics/rest.js";
export { RuntimeConfigSemanticsSchema } from "./semantics/runtimeConfig.js";
export { StorageRelationalSemanticsSchema } from "./semantics/storageRelational.js";

export type {
  BoundaryBehavior,
  BoundarySemanticsDefinition,
} from "./semantics/definition.js";

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type ConfidenceSource = z.infer<typeof ConfidenceSourceSchema>;
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;
export type ConfidenceInfo = z.infer<typeof ConfidenceInfoSchema>;
export type Corroboration = z.infer<typeof CorroborationSchema>;
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type BoundaryBinding = z.infer<typeof BoundaryBindingSchema>;

export type { DeployableUnit } from "./deployableUnit.js";
// TypeShape is a hand-written named recursive type in ./schemas (re-exported
// here) rather than a `z.infer`, so cross-package declarations reference it
// by name instead of inlining the recursion.
export type { TypeShape } from "./schemas.js";
export type { FunctionCallSemantics } from "./semantics/functionCall.js";
export type { GraphqlOperationSemantics } from "./semantics/graphqlOperation.js";
export type { GraphqlResolverSemantics } from "./semantics/graphqlResolver.js";
export type { MessageBusSemantics } from "./semantics/messageBus.js";
export type { Semantics } from "./semantics/registry.js";
export type { RestSemantics } from "./semantics/rest.js";
export type { RuntimeConfigSemantics } from "./semantics/runtimeConfig.js";
export type { StorageRelationalSemantics } from "./semantics/storageRelational.js";

// ---------------------------------------------------------------------------
// Shared comparison primitives
// ---------------------------------------------------------------------------
//
// Pure operations over the primitives above that more than one checker
// needs and must agree on. They live here so neither the behavioural
// checker nor the intent checker owns them (and so the two can't drift).

// ---------------------------------------------------------------------------
// Shared comparison primitives
// ---------------------------------------------------------------------------
//
// Pure operations over the primitives above that more than one checker
// needs and must agree on. They live here so neither the behavioural
// checker nor the intent checker owns them (and so the two can't drift).

// ---------------------------------------------------------------------------
// Shared comparison primitives
// ---------------------------------------------------------------------------
//
// Pure operations over the primitives above that more than one checker
// needs and must agree on. They live here so neither the behavioural
// checker nor the intent checker owns them (and so the two can't drift).

// ---------------------------------------------------------------------------
// Shared comparison primitives
// ---------------------------------------------------------------------------
//
// Pure operations over the primitives above that more than one checker
// needs and must agree on. They live here so neither the behavioural
// checker nor the intent checker owns them (and so the two can't drift).

export { boundaryKey, pairingKey, semanticsAgree } from "./boundaryKey.js";
export {
  busesAgree,
  channelsPair,
  type ParsedChannel,
  parseChannel,
} from "./channel.js";
export { codeScopePath, fileInCodeScope } from "./codeScope.js";
export { type DispatchTable, dispatchByType } from "./dispatch.js";
export { methodsAgree, normalizePath } from "./semantics/rest.js";
export {
  applySuppressionsToFindings,
  countsForThreshold,
  type FindingSuppression,
  normalizeRuleBoundary,
  ruleBoundaryMatchesKey,
  type SuppressableSeverity,
  type SuppressibleFinding,
  type SuppressionFile,
  SuppressionFileSchema,
  type SuppressionRule,
  SuppressionRuleSchema,
  validateRule,
} from "./suppressions.js";
export { bodyShapesMatch, type MatchResult } from "./typeShapeMatch.js";

// ---------------------------------------------------------------------------
// Boundary binding constructors
// ---------------------------------------------------------------------------
//
// The only blessed constructors for the three-layer binding shape.
// Direct `{ transport, semantics, recognition }` literals are fine too
// but must keep the discipline.

/**
 * A named identity part, or null when the source does not name one.
 * The empty string is refused loudly: it used to mean "unnamed" by
 * convention, three packs got the convention wrong three different
 * ways, and a throw at the builder puts the failure next to its cause.
 */
function namedOrNull(value: string | null, field: string): string | null {
  if (value === "") {
    throw new Error(
      `${field} is an empty string; write null when the source does not name it`,
    );
  }
  return value;
}

/**
 * Build a REST-semantics binding. `method` and `path` are null when
 * the source does not name them; `"*"` is the method wildcard for a
 * handler that answers every method. Pairing treats null as unnamed
 * (it pairs with nothing) and `"*"` as every concrete method.
 */
export function restBinding(opts: {
  transport: string;
  method: string | null;
  path: string | null;
  recognition: string;
  declaredResponses?: number[];
}): BoundaryBinding {
  const method = namedOrNull(opts.method, "rest method");
  return {
    transport: opts.transport,
    semantics: {
      name: "rest",
      method: method === null ? null : method.toUpperCase(),
      path: namedOrNull(opts.path, "rest path"),
      ...(opts.declaredResponses !== undefined
        ? { declaredResponses: opts.declaredResponses }
        : {}),
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a function-call-semantics binding. Used by in-process packs
 * (React components, custom-hook boundaries, bare TS function exports).
 */
export function functionCallBinding(opts: {
  transport: string;
  recognition: string;
  module?: string;
  exportName?: string;
  package?: string;
  exportPath?: string[];
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "function-call",
      ...(opts.module !== undefined ? { module: opts.module } : {}),
      ...(opts.exportName !== undefined ? { exportName: opts.exportName } : {}),
      ...(opts.package !== undefined ? { package: opts.package } : {}),
      ...(opts.exportPath !== undefined ? { exportPath: opts.exportPath } : {}),
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a function-call binding that identifies a public package export
 * — the provider side of a library boundary. Transport defaults to
 * `"in-process"` for typical TypeScript library consumption.
 */
export function packageExportBinding(opts: {
  transport?: string;
  recognition: string;
  packageName: string;
  exportPath: string[];
}): BoundaryBinding {
  return functionCallBinding({
    transport: opts.transport ?? "in-process",
    recognition: opts.recognition,
    package: opts.packageName,
    exportPath: opts.exportPath,
  });
}

/**
 * Build a graphql-resolver-semantics binding. Transport varies by
 * deployment: `"http"` for Apollo Server, `"aws-https"` for AppSync.
 */
export function graphqlResolverBinding(opts: {
  transport: string;
  recognition: string;
  /** Null when the source never names the type the resolver attaches to. */
  typeName: string | null;
  fieldName: string;
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "graphql-resolver",
      typeName: namedOrNull(opts.typeName, "resolver typeName"),
      fieldName: opts.fieldName,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a graphql-operation-semantics binding — the consumer side of a
 * GraphQL boundary. Anonymous operations leave `operationName` unset.
 */
export function graphqlOperationBinding(opts: {
  transport: string;
  recognition: string;
  operationType: "query" | "mutation" | "subscription";
  operationName?: string;
}): BoundaryBinding {
  return {
    transport: opts.transport,
    semantics: {
      name: "graphql-operation",
      operationType: opts.operationType,
      ...(opts.operationName !== undefined
        ? { operationName: opts.operationName }
        : {}),
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a runtime-config binding — the provider side of a runtime
 * configuration channel (env vars on a Lambda / ECS task / container /
 * k8s pod). Transport is `"os"`: env vars are handed to the process by
 * the OS at startup regardless of the deployment medium.
 */
export function runtimeConfigBinding(opts: {
  recognition: string;
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  instanceName: string;
}): BoundaryBinding {
  return {
    transport: "os",
    semantics: {
      name: "runtime-config",
      deploymentTarget: opts.deploymentTarget,
      instanceName: opts.instanceName,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a storage-relational binding — the provider side of a
 * relational storage table. Transport carries the `storageSystem`
 * value so the layering stays informative without a separate
 * wire-protocol taxonomy.
 */
export function storageRelationalBinding(opts: {
  recognition: string;
  storageSystem: "postgres" | "mysql" | "sqlite";
  scope: string;
  table: string;
}): BoundaryBinding {
  return {
    transport: opts.storageSystem,
    semantics: {
      name: "storage-relational",
      storageSystem: opts.storageSystem,
      scope: opts.scope,
      table: opts.table,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a message-bus binding — the boundary between a producer that
 * sends discrete messages and the consumer(s) that receive them.
 */
export function messageBusBinding(opts: {
  recognition: string;
  messageBus: "sqs" | "sns" | "eventbridge" | "bullmq" | "kafka" | "nats";
  /** Null when this source does not name the channel. */
  channel: string | null;
}): BoundaryBinding {
  return {
    transport: opts.messageBus,
    semantics: {
      name: "message-bus",
      messageBus: opts.messageBus,
      channel: namedOrNull(opts.channel, "message-bus channel"),
    },
    recognition: opts.recognition,
  };
}
