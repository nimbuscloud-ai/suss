/**
 * Reads an Application Load Balancer's routing as one-hop edges for the
 * reachability walk: `routesTo`, `answers`, `fronts` and `belongsTo`.
 * The README describes each edge.
 *
 * Each summary has exactly one edge, in the `routing` metadata, and no
 * boundary binding, since the checker does not pair these.
 *
 * No edge here spans more than one hop. The ECS lookup from target group
 * through service and task definition to container is fixed in length,
 * so it is settled here. A target group in front of another load
 * balancer stops at that balancer's logical id, and the reachability
 * rules follow the chain from there.
 */

import { withRoutingMetadata } from "@suss/behavioral-ir";
import { ecsContainerInstanceName } from "@suss/ir-core";
import { refTarget } from "@suss/manifest-aws";

import { ALB_MATCH_LANGUAGE } from "./albMatch.js";

import type { BehavioralSummary, RoutingMetadata } from "@suss/behavioral-ir";
import type { CloudFormationResource } from "@suss/manifest-aws";

interface UnresolvedRoutingRef {
  reference: string;
  reason: string;
}

interface RefResolution {
  logicalId: string | null;
  unresolved?: UnresolvedRoutingRef;
}

type MatchCondition = NonNullable<RoutingMetadata["conditions"]>[number];
type RoutingResponse = NonNullable<RoutingMetadata["response"]>;

// Each ALB condition `Field`, and the property that contains its values.
const CONDITION_CONFIG_KEYS: Record<string, string> = {
  "path-pattern": "PathPatternConfig",
  "host-header": "HostHeaderConfig",
  "http-request-method": "HttpRequestMethodConfig",
  "http-header": "HttpHeaderConfig",
  "query-string": "QueryStringConfig",
  "source-ip": "SourceIpConfig",
};

// Other fields are still recorded, marked unevaluated.
const EVALUATED_CONDITION_FIELDS = new Set(["path-pattern", "host-header"]);

/**
 * One summary per routing edge: `routesTo` or `answers` for each listener
 * rule and each listener's default action, `belongsTo` for each listener,
 * and `fronts` for each target group.
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
  // The rule's logical id, or the listener's for a default action.
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

// A weighted forward gives one `routesTo` per target group, all with one
// matchId. A match with no readable action still gets a row, with its
// target or response marked unresolved.
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

// Where traffic ends up: the forward action, or else the first action
// that is not an authenticate step. Authentication itself is not modelled.
// A list of only authenticate actions records the first one's type.
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

function isAuthenticateAction(action: unknown): boolean {
  if (action === null || typeof action !== "object") {
    return false;
  }

  const type = (action as { Type?: unknown }).Type;
  return typeof type === "string" && type.startsWith("authenticate-");
}

// A single TargetGroupArn, or the weighted list in ForwardConfig.
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

// Values come from the field's `*Config.Values`, or from the older bare
// `Values` that path-pattern and host-header also accept.
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

// `query-string` lists `{ Key?, Value }` pairs, flattened to `key=value`
// so every field fits the match record's list of strings.
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

// Named `<listener>#loadBalancer` to keep it apart from the listener's
// default-action row, which uses the listener's own id.
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

// A Lambda, the ECS container behind the registering service, or another
// load balancer. Nothing below recurses yet, so `visited` never grows past
// one entry; it guards against cycles if a later hop does.
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

// For TargetType ip, instance or unset: the ECS service that registers
// this group, then its TaskDefinition, then the ContainerName from the
// same LoadBalancers entry.
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

// Every way this can fail comes back as `unresolved` with a reason, so
// an edge is never dropped without a record of why.
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
