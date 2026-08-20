import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * The stores a Terraform module declares, paired against the code that
 * reaches them. Issue #463's repro was this exact configuration: a
 * `google_storage_bucket` and an `aws_elasticache_cluster` that came
 * back as "declares no boundaries suss could read".
 */
describe("check code against the stores a Terraform module declares", () => {
  const summaries = workspace("terraform-stores");
  const infraFile = path.join(summaries, "infra.json");

  beforeAll(() => {
    const code = runSuss([
      "extract",
      "--dir",
      fixture("terraform-stores"),
      "-f",
      "express",
      "-f",
      "gcs",
      "-f",
      "redis",
      "-f",
      "aws-s3",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "terraform",
      path.join(fixture("terraform-stores"), "main.tf"),
      "-o",
      infraFile,
    ]);
    expect(infra.status, infra.stderr).toBe(0);
  });

  it("reads a bucket and a cache cluster out of the configuration", () => {
    const declared = (readJson(infraFile) as BehavioralSummary[]).map(
      (s) => s.identity.name,
    );
    expect(declared).toContain("google_storage_bucket.uploads");
    expect(declared).toContain("aws_elasticache_cluster.sessions");
    expect(declared).toContain("aws_s3_bucket.archive");
  });

  it("pairs the GCS accesses against the declared bucket", () => {
    const check = runSuss(["check", "--dir", summaries, "--all"]);

    expect(check.stdout).toContain("gcs:uploads");
    expect(check.stdout).toContain(
      "main.tf::google_storage_bucket.uploads <-> terraform-stores::src/reportStore.ts::readReport",
    );
    expect(check.stdout).toContain(
      "main.tf::google_storage_bucket.uploads <-> terraform-stores::src/reportStore.ts::publishReport",
    );
  });

  it("pairs the S3 write against the declared bucket", () => {
    const check = runSuss(["check", "--dir", summaries, "--all"]);

    expect(check.stdout).toContain("s3:archive");
    expect(check.stdout).toContain(
      "main.tf::aws_s3_bucket.archive <-> terraform-stores::src/orderArchive.ts::archiveOrder",
    );
  });

  it("declares the Redis store without claiming the session namespace", () => {
    const check = runSuss(["check", "--dir", summaries, "--all"]);

    // The cluster is visible and unpaired: code addresses the
    // `session` key namespace, which no attribute of a cluster
    // declares, so a pair here would only ever be a name coincidence.
    expect(check.stdout).toContain("main.tf::aws_elasticache_cluster.sessions");
    expect(check.stdout).not.toContain("aws_elasticache_cluster.sessions <->");
    expect(check.stdout).toContain(
      "terraform-stores::src/sessionCache.ts::touchSession",
    );
  });
});
