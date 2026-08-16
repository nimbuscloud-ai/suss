/**
 * @suss/ir-core: primitives shared across suss IRs.
 *
 * The schemas are the single source of truth, and the types come from
 * them. Each boundary protocol's schema and behavior are in one module
 * under `./semantics`, and everything else is in `./schemas`. The
 * boundary-binding constructors are here too, so that any package that
 * produces an IR object (pattern packs, contract readers, intent docs,
 * tests) can build a binding without depending on a specific IR.
 */

import { GraphqlOperationSemanticsSchema } from "./semantics/graphqlOperation.js";

import type { z } from "zod";
import type {
  BoundaryBindingSchema,
  ConfidenceInfoSchema,
  ConfidenceLevelSchema,
  ConfidenceSourceSchema,
  CorroborationSchema,
  SourceLocationSchema,
} from "./schemas.js";
import type { MessageBusTechnology } from "./semantics/messageBus.js";

export {
  type BusIdentityKey,
  busIdentityKey,
  type FnIdentityKey,
  fnIdentityKey,
  type GqlIdentityKey,
  gqlIdentityKey,
} from "./identityKeys.js";
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
export { StorageSemanticsSchema } from "./semantics/storage.js";

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

export { ecsContainerInstanceName } from "./deployableUnit.js";

export type { DeployableUnit } from "./deployableUnit.js";
// TypeShape is a hand-written named recursive type in ./schemas (re-exported
// here) rather than a `z.infer`, so cross-package declarations reference it
// by name instead of inlining the recursion.
export type { TypeShape } from "./schemas.js";
export type { FunctionCallSemantics } from "./semantics/functionCall.js";
export type { GraphqlOperationSemantics } from "./semantics/graphqlOperation.js";
export type { GraphqlResolverSemantics } from "./semantics/graphqlResolver.js";
export type {
  MessageBusSemantics,
  MessageBusTechnology,
} from "./semantics/messageBus.js";
export type { Semantics } from "./semantics/registry.js";
export type { RestSemantics } from "./semantics/rest.js";
export type { RuntimeConfigSemantics } from "./semantics/runtimeConfig.js";
export type { StorageSemantics } from "./semantics/storage.js";

// ---------------------------------------------------------------------------
// Shared comparison primitives
// ---------------------------------------------------------------------------
//
// These are pure operations over the primitives above that more than one
// checker needs and that all of them have to agree on. They are here so
// that neither checker, behavioural or intent, owns them and the two
// cannot drift apart.

// normalizeRuleBoundary is defined in boundaryKey.ts too, but it is exported
// below with the suppressions, next to the matcher that uses it.
export {
  boundaryKey,
  boundaryLabel,
  canPair,
  displayLabel,
  exchangesHttpResponses,
  pairingKey,
  reportsUnpairedItself,
  semanticsAgree,
  servesRequest,
} from "./boundaryKey.js";
export {
  busesAgree,
  type Channel,
  channelsPair,
  formatChannel,
  type ParsedChannel,
  parseChannel,
} from "./channel.js";
export { codeScopePath, fileInCodeScope } from "./codeScope.js";
export { type DispatchTable, dispatchByType } from "./dispatch.js";
export {
  methodsAgree,
  normalizePath,
  routePathAdmits,
} from "./semantics/rest.js";
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
// These are the approved constructors for the three-layer binding structure.
// You can also write a `{ transport, semantics, recognition }` literal
// directly, but it has to follow the same rules.

/**
 * The identity part when the source gives one, or null when it does
 * not. An empty string throws: it used to mean "unnamed" by convention,
 * three packs got that convention wrong in three different ways, and
 * throwing here puts the failure right next to what caused it.
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
 * Build a REST-semantics binding. `method` and `path` are null when the
 * source does not specify them. `"*"` is the method wildcard, for a
 * handler that responds to every method. When pairing, null means
 * unspecified and matches nothing, and `"*"` matches every concrete method.
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
 * Build a function-call binding that identifies a public package export,
 * which is the provider side of a library boundary. Transport defaults
 * to `"in-process"`, which is how a TypeScript library is usually used.
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
  /** Null when the source never says which type the resolver attaches to. */
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
 * Build a graphql-operation-semantics binding, which is the consumer side
 * of a GraphQL boundary. Anonymous operations leave `operationName` unset.
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
 * Whether a binding is the consumer side of a GraphQL boundary,
 * settled by the protocol's own schema so callers do not compare the
 * semantics tag themselves.
 */
export function isGraphqlOperationBinding(
  binding: BoundaryBinding | null | undefined,
): boolean {
  return (
    binding != null &&
    GraphqlOperationSemanticsSchema.safeParse(binding.semantics).success
  );
}

/**
 * Build a runtime-config binding, the provider side of a runtime
 * configuration channel (env vars on a Lambda, ECS task, container, or
 * k8s pod). Transport is `"os"` because the OS hands env vars to the
 * process at startup no matter what the deployment medium is.
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
 * Build a storage binding, the side of a store that both a schema
 * reader and a call site can spell. `transport` defaults to the store's
 * own name, which is right for a database whose product and wire
 * protocol are the same word, and a store reached over an SDK passes
 * its wire instead.
 */
export function storageBinding(opts: {
  recognition: string;
  storageSystem: string;
  transport?: string;
  scope: string;
  /** Null when the source gives a container this reader could not settle. */
  container: string | null;
  /** A secondary index or alias, or null for the container's own primary key. */
  accessPath?: string | null;
}): BoundaryBinding {
  return {
    transport: opts.transport ?? opts.storageSystem,
    semantics: {
      name: "storage",
      storageSystem: opts.storageSystem,
      scope: opts.scope,
      container: namedOrNull(opts.container, "storage container"),
      accessPath: opts.accessPath ?? null,
    },
    recognition: opts.recognition,
  };
}

/**
 * Build a message-bus binding, the boundary between a producer that
 * sends discrete messages and the consumer(s) that receive them.
 */
export function messageBusBinding(opts: {
  recognition: string;
  messageBus: MessageBusTechnology;
  /** Null when this source does not say which channel. */
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
