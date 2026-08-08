/**
 * arn.ts resolves the references AWS manifests use to point at a queue, a
 * topic, or a bucket, down to the channel string suss keys the boundary on.
 *
 * Every manifest language that targets AWS writes a reference one of three
 * ways: as a CFN intrinsic (`!Ref X`, `!GetAtt X.Arn`), as a plain ARN
 * string, or as a bare name. The CloudFormation reader and the Serverless
 * Framework reader both resolve them here, so a queue written two different
 * ways in two manifest languages still ends up on one channel.
 */

import { refTarget } from "./templateLoader.js";

/**
 * Resolve a reference (`!Ref X`, `!GetAtt X.Arn`, plain string ARN) to
 * the referenced resource's channel string. `service` is the ARN
 * segment a plain string is checked against (`"sqs"`, `"sns"`, `"s3"`),
 * so a queue ARN, a topic ARN, and a bucket ARN all resolve through the
 * same code.
 *
 * Returns null when the reference is dynamic (a parameter, an import,
 * or an Fn::Join that points at nothing this template declares); those
 * need cross-stack resolution that's out of scope for v0.
 */
export function resolveResourceChannel(
  value: unknown,
  service: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    // Plain string: either the ARN of an external resource (we can't
    // resolve that to a logical id without the deployed stack) or, in
    // tests, a logical id passed directly.
    const resource = resolveArnResource(value, service);
    return resource ?? value;
  }
  return refTarget(value);
}

/**
 * Parse an ARN by its segments rather than matching it against a
 * pattern, and check it against `service`. It splits on `:` as
 * `arn:partition:service:region:account-id:resource`, and `resource` is
 * rejoined from everything after the account segment, because some ARNs
 * (an SNS subscription, say) append another `:`-separated id.
 *
 * `"s3"` requires region and account BOTH empty and a non-empty
 * resource, and an object ARN's trailing `/key` is stripped because the
 * bucket alone is the channel. Every other service requires region,
 * account, and resource all non-empty. A value that fails these checks
 * returns null, so a malformed ARN stays unresolved instead of
 * resolving to a bare name that could hit an unrelated logical id.
 */
function resolveArnResource(value: string, service: string): string | null {
  const parts = value.split(":");
  if (parts[0] !== "arn" || parts[2] !== service) {
    return null;
  }
  const region = parts[3];
  const account = parts[4];
  const resource = parts.slice(5).join(":");
  if (service === "s3") {
    if (region !== "" || account !== "" || resource === "") {
      return null;
    }
    const slash = resource.indexOf("/");
    const bucket = slash === -1 ? resource : resource.slice(0, slash);
    return bucket === "" ? null : bucket;
  }

  if (!region || !account || resource === "") {
    return null;
  }
  return resource;
}

/**
 * Resolve a Queue reference (`!Ref X`, `!GetAtt X.Arn`, plain string
 * ARN) to the queue's channel string.
 */
export function resolveQueueChannel(value: unknown): string | null {
  return resolveResourceChannel(value, "sqs");
}

/**
 * Resolve a Topic reference (`!Ref X`, `!GetAtt X.Arn`, plain string
 * ARN) to the topic's channel string.
 */
export function resolveTopicChannel(value: unknown): string | null {
  return resolveResourceChannel(value, "sns");
}

/**
 * Resolve a Bucket reference (`!Ref X`, `!GetAtt X.Arn`, plain string
 * ARN) to the bucket's channel string.
 */
export function resolveBucketChannel(value: unknown): string | null {
  return resolveResourceChannel(value, "s3");
}
