import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

import type { CheckIntentResult } from "@suss/checker-intent";

/**
 * A Lambda that writes a secret it only names through a variable. The
 * template sets API_KEY_SECRET_ID, so the store the code reaches is
 * prod/app/api-key, and a document that says which secret is worth
 * more to a reader than one that says which variable.
 *
 * The last steps are the point, the same as for the invoke journey
 * next door. A doc the command writes that the checker then argues
 * with is a defect in the mapping.
 */

const ROTATOR = "unit-lambda-secrets-rotator.intent.yaml";
const SYNC = "unit-lambda-parameter-sync.intent.yaml";

describe("infer intent for a Lambda whose store comes from a variable", () => {
  const root = workspace("config-store-intent");
  const summaries = path.join(root, "summaries");
  const intent = path.join(root, "intent");

  const curate = (file: string): void => {
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(/^purpose: "".*$/m, "purpose: Rotate the outbound API key.")
        .replace(/^audience: "".*$/m, "audience: the platform team")
        .replace(/^source: inferred$/m, 'source: "inferred, curated"'),
    );
  };

  const checkIntent = (dir: string): CheckIntentResult => {
    const run = runSuss([
      "check",
      "--dir",
      summaries,
      "--intent",
      dir,
      "--json",
    ]);
    return (JSON.parse(run.stdout) as { intent: CheckIntentResult }).intent;
  };

  beforeAll(() => {
    fs.mkdirSync(summaries, { recursive: true });

    const code = runSuss([
      "extract",
      "--dir",
      fixture("aws-config-stores"),
      "-f",
      "aws-lambda",
      "-f",
      "aws-secrets-manager",
      "-f",
      "aws-ssm",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "cloudformation",
      path.join(fixture("aws-config-stores"), "template.yaml"),
      "-o",
      path.join(summaries, "infra.json"),
    ]);
    expect(infra.status, infra.stderr).toBe(0);

    const drafted = runSuss([
      "infer",
      "intent",
      "--from",
      summaries,
      "--out",
      intent,
    ]);
    expect(drafted.status, drafted.stderr).toBe(0);
  }, 120_000);

  it("names the secret the template sets the variable to", () => {
    const doc = fs.readFileSync(path.join(intent, ROTATOR), "utf8");

    expect(doc).toContain(
      [
        "    results:",
        "      - reads: aws.secretsmanager:prod/db/password",
        "      - writes: aws.secretsmanager:prod/app/api-key",
      ].join("\n"),
    );
  });

  it("pairs every curated doc against the code it was drafted from", () => {
    curate(path.join(intent, ROTATOR));
    curate(path.join(intent, SYNC));

    const checked = checkIntent(intent);

    expect(checked.findings).toEqual([]);
    expect(checked.unchecked).toEqual([]);
    expect(
      checked.checked.map((one) =>
        one.kind === "boundary" ? one.boundary : one.intent,
      ),
    ).toEqual(["unit:lambda ParameterSync", "unit:lambda SecretsRotator"]);
  });

  it("reports a renamed secret as one finding", () => {
    const drift = path.join(root, "store");
    fs.mkdirSync(drift, { recursive: true });
    fs.writeFileSync(
      path.join(drift, ROTATOR),
      fs
        .readFileSync(path.join(intent, ROTATOR), "utf8")
        .replace("prod/app/api-key", "prod/app/other-key"),
    );

    const checked = checkIntent(drift);

    expect(checked.findings.map((f) => f.kind)).toEqual(["renamedBoundary"]);
    expect(checked.findings[0].severity).toBe("error");
    expect(checked.findings[0].message).toBe(
      'Intent "unit-lambda-secrets-rotator" declares aws.secretsmanager:prod/app/other-key; SecretsRotator.handler writes aws.secretsmanager:prod/app/api-key instead, with the same outcomes. If the store was renamed, update the intent.',
    );
  });
});
