import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, readJson, runSuss, workspace } from "../harness.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

/**
 * A service that signs and posts its own DynamoDB request writes no SDK
 * command class, so the only evidence is the wire: the operation goes in
 * the target header and the request goes in the body. suss reads which
 * parameter reaches each before extraction, and the tables come from the
 * call sites.
 */
describe("read a project's own signed DynamoDB request", () => {
  const out = workspace("dynamodb-signed-request");
  const summariesFile = path.join(out, "api.json");

  function accesses(): string[] {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    return summaries
      .flatMap((one) => one.transitions)
      .flatMap((transition) => transition.effects as Effect[])
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access"
          ? [
              `${effect.interaction.kind} ${effect.binding.semantics.name === "storage" ? effect.binding.semantics.container : "?"}`,
            ]
          : [],
      )
      .sort();
  }

  it("names the table each call reaches, with no pack config", () => {
    const run = runSuss([
      "extract",
      "--dir",
      fixture("dynamodb-signed-request"),
      "-f",
      "express",
      "-f",
      "aws-dynamodb",
      "-o",
      summariesFile,
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(accesses()).toEqual(["read orders-v1", "write orders-v1"]);
  });

  it("takes the operation the wire states as read or write", () => {
    const summaries = readJson(summariesFile) as BehavioralSummary[];
    const operations = summaries
      .flatMap((one) => one.transitions)
      .flatMap((transition) => transition.effects as Effect[])
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access"
          ? [effect.interaction.operation]
          : [],
      )
      .sort();
    expect(operations).toEqual(["PutItem", "Query"]);
  });

  it("warns and keeps going when a config file still sets the option", () => {
    const config = path.join(out, "dynamo.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        requestFunctions: [
          {
            name: "sendRequest",
            operationArg: 2,
            requestArg: 3,
            operations: { Query: "read" },
          },
        ],
      }),
    );
    const run = runSuss([
      "extract",
      "--dir",
      fixture("dynamodb-signed-request"),
      "-f",
      `aws-dynamodb=${config}`,
      "-o",
      summariesFile,
      // The effects pack alone discovers no routes, and the warning is
      // what this run is for.
      "--allow-empty",
    ]);
    // 0.20.0 told everyone setting this to write a dependency stub,
    // which was the wrong instruction for a first-party helper, so the
    // key is read past with a warning until 0.22.0 rather than refused.
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("ignores requestFunctions");
    expect(run.stderr).toContain("0.22.0");
    expect(run.stderr).not.toContain("suss infer stub");
  });
});
