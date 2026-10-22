import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

import type { Finding } from "@suss/behavioral-ir";

/**
 * A route whose 200 sends `exists` and whose failures do not, called by
 * two clients that never read the status. One writes an `else` for a
 * body without `exists`, so its failures land there. The other writes
 * nothing for that case, and its 400 and 500 are still reported.
 */
describe("a client that tells a failure apart by a field only a success sends", () => {
  const out = workspace("body-field-guards");

  beforeAll(() => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("body-field-guards"),
      "-f",
      "nextjs",
      "-f",
      "fetch",
      "-o",
      path.join(out, "code.json"),
    ]);
    expect(extract.status, extract.stderr).toBe(0);
  });

  it("counts the else as handling the failures, and reports the client with none", () => {
    const check = runSuss(["check", "--dir", out, "--json"]);
    const findings = (JSON.parse(check.stdout) as { findings: Finding[] })
      .findings;

    expect(
      findings.map(
        (finding) =>
          `${finding.consumer.summary.split("::")[1]}: ${finding.description}`,
      ),
    ).toEqual([
      "prefetchLogo: Provider produces status 400 but no consumer branch handles it",
      "prefetchLogo: Provider produces status 500 but no consumer branch handles it",
    ]);
  });
});
