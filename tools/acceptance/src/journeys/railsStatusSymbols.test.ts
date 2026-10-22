import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

/**
 * A Rails controller that sends 422 as `:unprocessable_content`, the
 * name Rack 3 gave it, and a TypeScript client that checks for 422. The
 * symbol written at the render reads as 422. The same symbol picked in a
 * branch and rendered once claims no status, so the client's 422 check
 * against it is not called dead. The client's 410 check is.
 */
describe("read the status symbols Rack 3 renamed", () => {
  const out = workspace("rails-status-symbols");
  const railsFile = path.join(out, "rails.json");

  beforeAll(() => {
    const rails = runSuss([
      "extract",
      "--lang",
      "ruby",
      "--dir",
      fixture("rails-status-symbols"),
      "-f",
      `rails=${path.join(fixture("rails-status-symbols"), "suss.rails.json")}`,
      "-o",
      railsFile,
    ]);
    expect(rails.status, rails.stderr).toBe(0);

    const client = runSuss([
      "extract",
      "--dir",
      path.join(fixture("rails-status-symbols"), "client"),
      "-f",
      "fetch",
      "-o",
      path.join(out, "web.json"),
    ]);
    expect(client.status, client.stderr).toBe(0);
  });

  it("reads :unprocessable_content as 422", () => {
    const summaries = readJson(railsFile) as BehavioralSummary[];
    const create = summaries.find((one) => one.identity.name === "create");

    expect(
      create?.transitions.map((transition) =>
        transition.output.type === "response" &&
        transition.output.statusCode?.type === "literal"
          ? transition.output.statusCode.value
          : null,
      ),
    ).toEqual([201, 422]);
  });

  it("reports only the branch for a status the controller never sends", () => {
    const check = runSuss(["check", "--dir", out, "--json"]);
    const findings = (JSON.parse(check.stdout) as { findings: Finding[] })
      .findings;

    expect(
      findings.map((finding) => `${finding.kind} ${finding.description}`),
    ).toEqual([
      "deadConsumerBranch Consumer expects status 410 but provider never produces it",
    ]);
  });
});
