// arn.ts: resolve the references AWS manifests use to name a queue,
// a topic, or a bucket, down to the channel string suss keys the
// boundary on.
//
// Every manifest language that targets AWS writes the same three
// shapes: a CFN intrinsic (`!Ref X`, `!GetAtt X.Arn`), a plain ARN
// string, or a bare name. The CloudFormation reader and the Serverless
// Framework reader both resolve them here, so a queue named two ways
// in two manifest languages still lands on one channel.

import { refTarget } from "./templateLoader.js";

/**
 * Resolve a reference (`!Ref X`, `!GetAtt X.Arn`, plain string ARN) to
 * the referenced resource's channel string. `service` is the ARN
 * segment a plain string is checked against (`"sqs"`, `"sns"`, `"s3"`),
 * so a queue ARN, a topic ARN, and a bucket ARN each resolve through
 * the same shape.
 *
 * Returns null when the reference is dynamic (a parameter, an import,
 * or an Fn::Join naming nothing this template declares); those need
 * cross-stack resolution that's out of scope for v0.
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
 * Parse an ARN structurally rather than matching it against a pattern,
 * and validate its shape against `service`. `arn:partition:service:
 * region:account-id:resource` splits on `:`; `resource` is rejoined
 * from whatever follows the account segment, since some ARN shapes
 * (an SNS subscription, say) append a further `:`-separated id.
 *
 * `"s3"` requires region and account BOTH empty
 * (`arn:aws:s3:::bucket-name` carries neither) and a non-empty
 * resource; an object ARN appends `/key` after the bucket name, which
 * is stripped since the bucket alone is the channel. Every other
 * service requires region, account, and resource all non-empty. A
 * value that doesn't validate returns null, so a malformed ARN (a
 * dropped region or account) falls through unresolved rather than
 * resolving to a bare name that can coincidentally collide with an
 * unrelated logical id.
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
