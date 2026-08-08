// albFlow.ts: read an Application Load Balancer's routing chain as
// the edges docs/internal/proposals/flow-reachability.md names:
//
//   routesTo(router, target, matchId)   a listener rule, or a
//                                       listener's own forward default
//                                       action, naming the target group
//                                       its match forwards to. The
//                                       match's conditions and priority
//                                       live on the same record.
//   answers(router, matchId, response)  a rule's or a listener's own
//                                       non-forward action: the
//                                       response a path gets without
//                                       forwarding anywhere. A rule's
//                                       conditions and priority live on
//                                       this record too; a listener's
//                                       own default has neither.
//   fronts(target, resource)            what a target group backs onto:
//                                       an ECS container, a Lambda
//                                       function, or another load
//                                       balancer (an NLB in front of an
//                                       ALB).
//   belongsTo(listener, loadBalancer)   which load balancer a listener
//                                       belongs to, read from its
//                                       LoadBalancerArn, so a chain of
//                                       balancers composes: a fronts
//                                       edge ends at a balancer's
//                                       logical id and this edge is how
//                                       the walk continues into that
//                                       balancer's own listeners.
//
// One summary states exactly one edge, carried in the `routing`
// metadata namespace (@suss/behavioral-ir). No boundaryBinding: these
// edges are not a provider/consumer pairing the checker matches today,
// they are the fact base a future reachability rule walks. Nothing here
// resolves what an edge ultimately reaches across more than one hop:
// the ECS chain (target group to service to task definition to
// container) is a fixed, bounded lookup this reader settles, the same
// way the manifests-as-facts proposal treats a nested stack's
// parameter chain; a target group fronting another load balancer stops
// at that load balancer's own logical id, and composing the chain
// beyond it is the reachability rule's job (slice 3), never this
// reader's.

import { withRoutingMetadata } from "@suss/behavioral-ir";
import { ecsContainerInstanceName } from "@suss/ir-core";
import { refTarget } from "@suss/manifest-aws";

import { ALB_MATCH_LANGUAGE } from "./albMatch.js";

import type { BehavioralSummary, RoutingMetadata } from "@suss/behavioral-ir";
import type { CloudFormationResource } from "@suss/manifest-aws";

/** A reference this reader could not resolve to a declared resource of the expected kind. */
interface UnresolvedRoutingRef {
  reference: string;
  reason: string;
}

/** Either a resolved logical id, or why resolution stopped. */
interface RefResolution {
  logicalId: string | null;
  unresolved?: UnresolvedRoutingRef;
}

type MatchCondition = NonNullable<RoutingMetadata["conditions"]>[number];
type RoutingResponse = NonNullable<RoutingMetadata["response"]>;

/** Every ALB condition `Field` CFN defines, and the nested config property its values live under. */
const CONDITION_CONFIG_KEYS: Record<string, string> = {
  "path-pattern": "PathPatternConfig",
  "host-header": "HostHeaderConfig",
  "http-request-method": "HttpRequestMethodConfig",
  "http-header": "HttpHeaderConfig",
  "query-string": "QueryStringConfig",
  "source-ip": "SourceIpConfig",
};

/** Condition fields v0 actually matches against a request. Every other declared field is still read and recorded, marked unevaluated. */
const EVALUATED_CONDITION_FIELDS = new Set(["path-pattern", "host-header"]);

/**
 * Walk a template's ALB resources and emit one `library`-kind summary
 * per routing edge: a `routesTo` or `answers` row per listener rule and
 * per listener's own default action, a `belongsTo` row per listener,
 * and a `fronts` row per target group.
 */
export function buildAlbFlowSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];

  for (const [listenerId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ElasticLoadBalancingV2::Listener") {
      continue;
    }
    summaries.push(
      ...buildMatchSummaries({
        identityBase: listenerId,
        router: listenerId,
        matchId: `${listenerId}#default`,
        actionsRaw: resource.Properties?.DefaultActions,
        conditions: [],
        resources,
        sourceFile,
      }),
      buildBelongsToSummary(listenerId, resource, resources, sourceFile),
    );
  }

  for (const [ruleId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ElasticLoadBalancingV2::ListenerRule") {
      continue;
    }
    const props = resource.Properties ?? {};
    const router = resolveRefOfType(
      props.ListenerArn,
      resources,
      "AWS::ElasticLoadBalancingV2::Listener",
    );
    const priority = readPriority(props.Priority);
    summaries.push(
      ...buildMatchSummaries({
        identityBase: ruleId,
        router: router.logicalId,
        ...(router.unresolved !== undefined
          ? { unresolvedRouter: router.unresolved }
          : {}),
        matchId: ruleId,
        actionsRaw: props.Actions,
        ...(priority !== undefined ? { priority } : {}),
        conditions: readConditions(props.Conditions),
        resources,
        sourceFile,
      }),
    );
  }

  for (const [targetGroupId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ElasticLoadBalancingV2::TargetGroup") {
      continue;
    }
    summaries.push(
      buildFrontsSummary(targetGroupId, resource, resources, sourceFile),
    );
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// routesTo / answers
// ---------------------------------------------------------------------------

interface MatchSummariesOpts {
  /** Rule (or listener, for a default action) logical id: the summary's own identity and the matchId's base. */
  identityBase: string;
  router: string | null;
  unresolvedRouter?: UnresolvedRoutingRef;
  matchId: string;
  actionsRaw: unknown;
  priority?: number;
  conditions: MatchCondition[];
  resources: Record<string, CloudFormationResource>;
  sourceFile: string;
}

/**
 * One match (a rule, or a listener's own default action) becomes one or
 * more `routesTo` rows sharing a matchId (several, for a weighted
 * forward naming more than one target group) or a single `answers` row.
 * An action list naming neither a forward target nor a readable
 * non-forward action still produces one row: never dropped, its target
 * or response recorded as unresolved instead.
 */
function buildMatchSummaries(opts: MatchSummariesOpts): BehavioralSummary[] {
  const classification = classifyActions(opts.actionsRaw);

  if (classification.kind === "answers") {
    return [
      buildRoutingSummary(opts.identityBase, opts.sourceFile, {
        edge: "answers",
        router: opts.router,
        ...(opts.unresolvedRouter !== undefined
          ? { unresolvedRouter: opts.unresolvedRouter }
          : {}),
        matchId: opts.matchId,
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        conditions: opts.conditions,
        matchLanguage: ALB_MATCH_LANGUAGE,
        response: classification.response,
      }),
    ];
  }

  if (classification.targets.length === 0) {
    return [
      buildRoutingSummary(opts.identityBase, opts.sourceFile, {
        edge: "routesTo",
        router: opts.router,
        ...(opts.unresolvedRouter !== undefined
          ? { unresolvedRouter: opts.unresolvedRouter }
          : {}),
        target: null,
        unresolvedTarget: {
          reference: "(none)",
          reason: "a forward action named no target group",
        },
        matchId: opts.matchId,
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        conditions: opts.conditions,
        matchLanguage: ALB_MATCH_LANGUAGE,
      }),
    ];
  }

  return classification.targets.map((forwardTarget, index) => {
    const resolved = resolveRefOfType(
      forwardTarget.targetRef,
      opts.resources,
      "AWS::ElasticLoadBalancingV2::TargetGroup",
    );
    const identityName =
      classification.targets.length === 1
        ? opts.identityBase
        : `${opts.identityBase}#${index}`;
    return buildRoutingSummary(identityName, opts.sourceFile, {
      edge: "routesTo",
      router: opts.router,
      ...(opts.unresolvedRouter !== undefined
        ? { unresolvedRouter: opts.unresolvedRouter }
        : {}),
      target: resolved.logicalId,
      ...(resolved.unresolved !== undefined
        ? { unresolvedTarget: resolved.unresolved }
        : {}),
      matchId: opts.matchId,
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      conditions: opts.conditions,
      matchLanguage: ALB_MATCH_LANGUAGE,
      ...(forwardTarget.weight !== undefined
        ? { weight: forwardTarget.weight }
        : {}),
    });
  });
}

interface ForwardTarget {
  targetRef: unknown;
  weight?: number;
}

type ActionClassification =
  | { kind: "forward"; targets: ForwardTarget[] }
  | { kind: "answers"; response: RoutingResponse };

/**
 * An action list's terminal disposition: the forward action if the list
 * has one (auth actions such as authenticate-cognito may precede it;
 * v0 does not model the auth gate, only where traffic ends up), else
 * the response the first non-authenticate action states. A list that is
 * nothing but authenticate actions falls back to its first entry, so
 * the row still records the only type the template gives.
 */
function classifyActions(actionsRaw: unknown): ActionClassification {
  const actions = Array.isArray(actionsRaw) ? actionsRaw : [];
  const forward = actions.find(
    (action): action is Record<string, unknown> =>
      action !== null &&
      typeof action === "object" &&
      (action as { Type?: unknown }).Type === "forward",
  );
  if (forward !== undefined) {
    return { kind: "forward", targets: readForwardTargets(forward) };
  }

  const terminal = actions.find((action) => !isAuthenticateAction(action));
  return { kind: "answers", response: readResponse(terminal ?? actions[0]) };
}

/** authenticate-cognito / authenticate-oidc: a gate before the action that answers, never the answer itself. */
function isAuthenticateAction(action: unknown): boolean {
  if (action === null || typeof action !== "object") {
    return false;
  }

  const type = (action as { Type?: unknown }).Type;
  return typeof type === "string" && type.startsWith("authenticate-");
}

/** A forward action's target group(s): the plain single-target shape, or a weighted ForwardConfig's list. */
function readForwardTargets(action: Record<string, unknown>): ForwardTarget[] {
  if (action.TargetGroupArn !== undefined) {
    return [{ targetRef: action.TargetGroupArn }];
  }
  const forwardConfig = action.ForwardConfig;
  if (forwardConfig === null || typeof forwardConfig !== "object") {
    return [];
  }
  const groups = (forwardConfig as { TargetGroups?: unknown }).TargetGroups;
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups
    .filter(
      (group): group is Record<string, unknown> =>
        group !== null && typeof group === "object",
    )
    .map((group) => {
      const weight =
        typeof group.Weight === "number" ? group.Weight : undefined;
      return {
        targetRef: group.TargetGroupArn,
        ...(weight !== undefined ? { weight } : {}),
      };
    });
}

/** A non-forward action's response, or the null-typed record when the template gives no readable action. */
function readResponse(action: unknown): RoutingResponse {
  if (action === null || typeof action !== "object") {
    return { type: null };
  }
  const props = action as Record<string, unknown>;
  const type =
    typeof props.Type === "string" && props.Type.length > 0 ? props.Type : null;
  if (type !== "fixed-response") {
    return { type };
  }
  const config = props.FixedResponseConfig;
  const cfg =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const statusCode = parseStatusCode(cfg.StatusCode);
  return {
    type,
    ...(statusCode !== null ? { statusCode } : {}),
    ...(typeof cfg.ContentType === "string"
      ? { contentType: cfg.ContentType }
      : {}),
    ...(typeof cfg.MessageBody === "string" ? { body: cfg.MessageBody } : {}),
  };
}

function parseStatusCode(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return null;
}

function readPriority(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return undefined;
}

/**
 * Every condition a rule (or a listener default, which names none)
 * declares. Each field reads its values out of its own nested
 * `*Config.Values` shape, or the legacy bare `Values` property on the
 * condition itself for the two fields old enough to have one.
 * `path-pattern` and `host-header` are the only fields v0 matches
 * against a request; every other field, and a condition with no
 * readable Field at all, is still recorded, marked unevaluated rather
 * than dropped.
 */
function readConditions(raw: unknown): MatchCondition[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object",
    )
    .map(readCondition);
}

function readCondition(condition: Record<string, unknown>): MatchCondition {
  const field =
    typeof condition.Field === "string" && condition.Field.length > 0
      ? condition.Field
      : null;
  const configKey = field !== null ? CONDITION_CONFIG_KEYS[field] : undefined;
  const nested = configKey !== undefined ? condition[configKey] : undefined;
  const nestedValues =
    nested !== null && typeof nested === "object"
      ? (nested as { Values?: unknown }).Values
      : undefined;
  const values =
    readConditionValues(nestedValues) ??
    readConditionValues(condition.Values) ??
    [];
  return {
    field,
    values,
    evaluated: field !== null && EVALUATED_CONDITION_FIELDS.has(field),
  };
}

/**
 * A condition's `Values` array as strings. Most fields list plain
 * strings; `query-string` lists `{Key?, Value}` pairs instead, flattened
 * to `key=value` (or the bare value with no Key) so every field fits
 * the one string list on the match record.
 */
function readConditionValues(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const values = raw
    .map(flattenConditionValue)
    .filter((v): v is string => v !== null);
  return values.length > 0 ? values : null;
}

function flattenConditionValue(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  const props = entry as Record<string, unknown>;
  if (typeof props.Value !== "string") {
    return null;
  }
  return typeof props.Key === "string"
    ? `${props.Key}=${props.Value}`
    : props.Value;
}

// ---------------------------------------------------------------------------
// belongsTo
// ---------------------------------------------------------------------------

/**
 * The listener's own membership: which load balancer its
 * LoadBalancerArn points at. One row per listener, named apart from the
 * listener's default-action row so the two summaries stay two facts.
 */
function buildBelongsToSummary(
  listenerId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary {
  const loadBalancer = resolveRefOfType(
    resource.Properties?.LoadBalancerArn,
    resources,
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
  );
  return buildRoutingSummary(`${listenerId}#loadBalancer`, sourceFile, {
    edge: "belongsTo",
    router: listenerId,
    resource: loadBalancer.logicalId,
    ...(loadBalancer.unresolved !== undefined
      ? { unresolvedResource: loadBalancer.unresolved }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// fronts
// ---------------------------------------------------------------------------

function buildFrontsSummary(
  targetGroupId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary {
  const resolved = resolveFrontedResource(
    targetGroupId,
    resource,
    resources,
    new Set(),
  );
  return buildRoutingSummary(targetGroupId, sourceFile, {
    edge: "fronts",
    target: targetGroupId,
    resource: resolved.logicalId,
    ...(resolved.unresolved !== undefined
      ? { unresolvedResource: resolved.unresolved }
      : {}),
  });
}

/**
 * What a target group ultimately points at as its own registered target,
 * one hop: a Lambda function, the ECS container behind whichever
 * service registers it, or, for an NLB fronting an ALB directly,
 * another load balancer. Never follows a second target group itself, so
 * a chain (or a cycle) between load balancers is several one-hop
 * `fronts` facts rather than something this function walks; composing
 * the chain is the reachability rule's job. `visited` guards it anyway:
 * nothing below calls back into this function today, so it never grows
 * past one entry, but a hop added here later inherits cycle safety for
 * free rather than needing to invent it.
 */
function resolveFrontedResource(
  targetGroupId: string,
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
  visited: Set<string>,
): RefResolution {
  if (visited.has(targetGroupId)) {
    return {
      logicalId: null,
      unresolved: {
        reference: targetGroupId,
        reason:
          "already resolving this target group; stopping to avoid a cycle",
      },
    };
  }
  visited.add(targetGroupId);

  const targetType = resource.Properties?.TargetType;
  if (targetType === "lambda") {
    return resolveLambdaTarget(resource, resources);
  }
  if (targetType === "alb") {
    return resolveLoadBalancerTarget(resource, resources);
  }
  return resolveEcsTarget(targetGroupId, resources);
}

function firstTargetRef(resource: CloudFormationResource): unknown {
  const targets = resource.Properties?.Targets;
  const first = Array.isArray(targets) ? targets[0] : undefined;
  return first !== null && typeof first === "object"
    ? (first as { Id?: unknown }).Id
    : undefined;
}

function resolveLambdaTarget(
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): RefResolution {
  const idRef = firstTargetRef(resource);
  if (idRef === undefined) {
    return {
      logicalId: null,
      unresolved: {
        reference: "(none)",
        reason: "a lambda target group named no target",
      },
    };
  }
  return resolveRefOfType(idRef, resources, [
    "AWS::Lambda::Function",
    "AWS::Serverless::Function",
  ]);
}

function resolveLoadBalancerTarget(
  resource: CloudFormationResource,
  resources: Record<string, CloudFormationResource>,
): RefResolution {
  const idRef = firstTargetRef(resource);
  if (idRef === undefined) {
    return {
      logicalId: null,
      unresolved: {
        reference: "(none)",
        reason: "an alb target group named no target",
      },
    };
  }
  return resolveRefOfType(
    idRef,
    resources,
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
  );
}

/**
 * The ECS chain a target group of any other TargetType (ip, instance,
 * or unset) resolves through: search every AWS::ECS::Service for the
 * one whose LoadBalancers entry points at this target group, then that
 * service's TaskDefinition, then the container name the same
 * LoadBalancers entry gives. A fixed three-hop lookup the reader
 * settles once here, not a walk.
 */
function resolveEcsTarget(
  targetGroupId: string,
  resources: Record<string, CloudFormationResource>,
): RefResolution {
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::ECS::Service") {
      continue;
    }
    const loadBalancers = resource.Properties?.LoadBalancers;
    if (!Array.isArray(loadBalancers)) {
      continue;
    }
    for (const entry of loadBalancers) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const props = entry as Record<string, unknown>;
      const registered = resolveRefOfType(
        props.TargetGroupArn,
        resources,
        "AWS::ElasticLoadBalancingV2::TargetGroup",
      );
      if (registered.logicalId !== targetGroupId) {
        continue;
      }
      const containerName =
        typeof props.ContainerName === "string" ? props.ContainerName : null;
      if (containerName === null) {
        return {
          logicalId: null,
          unresolved: {
            reference: targetGroupId,
            reason: "the registering ECS::Service names no ContainerName",
          },
        };
      }
      const taskDefinition = resolveRefOfType(
        resource.Properties?.TaskDefinition,
        resources,
        "AWS::ECS::TaskDefinition",
      );
      if (taskDefinition.logicalId === null) {
        return {
          logicalId: null,
          unresolved: taskDefinition.unresolved ?? {
            reference: targetGroupId,
            reason:
              "the registering ECS::Service names no resolvable TaskDefinition",
          },
        };
      }
      return {
        logicalId: ecsContainerInstanceName(
          taskDefinition.logicalId,
          containerName,
        ),
      };
    }
  }
  return {
    logicalId: null,
    unresolved: {
      reference: targetGroupId,
      reason: "no ECS::Service registers this target group",
    },
  };
}

// ---------------------------------------------------------------------------
// Shared ref resolution and summary building
// ---------------------------------------------------------------------------

/**
 * Follow a CFN reference and confirm it points at a declared resource of
 * one of the expected types. Every failure mode, an unset value, a
 * value that points at nothing CFN resolves, a dangling logical id, or a
 * resource of the wrong type, comes back as `unresolved` with a reason
 * rather than as an exception or a silently dropped edge.
 */
function resolveRefOfType(
  value: unknown,
  resources: Record<string, CloudFormationResource>,
  expectedType: string | string[],
): RefResolution {
  const expected = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (value === undefined) {
    return {
      logicalId: null,
      unresolved: { reference: "(none)", reason: "no reference is set" },
    };
  }
  const id = refTarget(value);
  if (id === null) {
    return {
      logicalId: null,
      unresolved: {
        reference: describeRef(value),
        reason: "not a recognized reference",
      },
    };
  }
  const resource = resources[id];
  if (resource === undefined) {
    return {
      logicalId: null,
      unresolved: {
        reference: id,
        reason: `no resource named ${id} is declared`,
      },
    };
  }
  if (!expected.includes(resource.Type ?? "")) {
    return {
      logicalId: null,
      unresolved: {
        reference: id,
        reason: `${id} is ${resource.Type ?? "untyped"}, not ${expected.join(" or ")}`,
      },
    };
  }
  return { logicalId: id };
}

/**
 * The unrecognized reference `resolveRefOfType` names as its
 * `unresolved.reference`. Its only caller reaches this after
 * `refTarget` returns null, which happens for an object shape it does
 * not know, never for a plain string (`refTarget` resolves those to
 * themselves), so there is always something to stringify.
 */
function describeRef(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildRoutingSummary(
  identityName: string,
  sourceFile: string,
  routing: RoutingMetadata,
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: identityName,
      exportPath: null,
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withRoutingMetadata(undefined, routing),
  };
}
