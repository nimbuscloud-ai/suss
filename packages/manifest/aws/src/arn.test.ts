import { describe, expect, it } from "vitest";

import {
  resolveBucketChannel,
  resolveQueueChannel,
  resolveTopicChannel,
} from "./arn.js";

describe("resolveQueueChannel", () => {
  it("resolves a Ref to the logical id", () => {
    expect(resolveQueueChannel({ Ref: "OrdersQueue" })).toBe("OrdersQueue");
  });

  it("resolves a GetAtt to the logical id", () => {
    expect(resolveQueueChannel({ "Fn::GetAtt": ["OrdersQueue", "Arn"] })).toBe(
      "OrdersQueue",
    );
  });

  it("resolves a full queue ARN to the queue name", () => {
    expect(
      resolveQueueChannel("arn:aws:sqs:us-east-1:123456789012:orders"),
    ).toBe("orders");
  });

  it("passes a bare string through unchanged", () => {
    expect(resolveQueueChannel("OrdersQueue")).toBe("OrdersQueue");
  });

  it("keeps a malformed ARN whole rather than resolving a bare name", () => {
    // A dropped region or account could otherwise collide with an
    // unrelated logical id.
    expect(resolveQueueChannel("arn:aws:sqs:::orders")).toBe(
      "arn:aws:sqs:::orders",
    );
  });

  it("answers null for a value naming nothing", () => {
    expect(resolveQueueChannel(undefined)).toBeNull();
    expect(resolveQueueChannel({ "Fn::Join": [":", []] })).toBeNull();
  });
});

describe("resolveTopicChannel", () => {
  it("resolves a topic ARN to the topic name", () => {
    expect(
      resolveTopicChannel("arn:aws:sns:us-east-1:123456789012:dispatch"),
    ).toBe("dispatch");
  });

  it("rejects an ARN of another service", () => {
    // The value comes back whole, never read as a resource name.
    expect(
      resolveTopicChannel("arn:aws:sqs:us-east-1:123456789012:orders"),
    ).toBe("arn:aws:sqs:us-east-1:123456789012:orders");
  });
});

describe("resolveBucketChannel", () => {
  it("resolves a bucket ARN, which carries no region or account", () => {
    expect(resolveBucketChannel("arn:aws:s3:::uploads")).toBe("uploads");
  });

  it("strips an object key down to the bucket", () => {
    expect(resolveBucketChannel("arn:aws:s3:::uploads/incoming/a.csv")).toBe(
      "uploads",
    );
  });

  it("keeps a bucket ARN carrying a region whole, since S3 ARNs carry none", () => {
    expect(resolveBucketChannel("arn:aws:s3:us-east-1::uploads")).toBe(
      "arn:aws:s3:us-east-1::uploads",
    );
  });
});
