/**
 * A frontend whose every request goes through a generated client, run
 * through the built binary.
 *
 * Nothing in the fixture calls axios with a path. The paths are written
 * in the service class, two of the project's own functions away from
 * the library, and the verb is a method on an object literal in
 * between.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const BIN = path.resolve(__dirname, "../dist/bin.js");
const FIXTURE = path.resolve(
  __dirname,
  "../../../fixtures/axios/generated-sdk",
);

let summaries: BehavioralSummary[];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-generated-sdk-"));
  const output = path.join(dir, "summaries.json");
  const extract = spawnSync(
    process.execPath,
    [
      BIN,
      "extract",
      "--dir",
      FIXTURE,
      "-f",
      "axios",
      "--no-cache",
      "-o",
      output,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  expect(extract.status, extract.stderr).toBe(0);
  summaries = Object.values(
    JSON.parse(fs.readFileSync(output, "utf8")) as Record<
      string,
      BehavioralSummary
    >,
  );
});

function requestsByName(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const summary of summaries) {
    const semantics = summary.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "rest") {
      continue;
    }
    found[summary.identity.name] =
      `${semantics.method ?? "<none>"} ${semantics.path ?? "<none>"}`;
  }
  return found;
}

describe("a project whose requests go through a generated client", () => {
  it("reports one request per service method, with the verb the client wrote", () => {
    expect(requestsByName()).toMatchObject({
      readUsers: "GET /api/v1/users/",
      createUser: "POST /api/v1/users/",
      deleteUser: "DELETE /api/v1/users/{user_id}",
    });
  });

  it("leaves the request layer itself with no path, since it states none", () => {
    expect(requestsByName().request).toBe("GET <none>");
  });

  it("stops at the service method, which is where the path is written", () => {
    expect(Object.keys(requestsByName()).sort()).toEqual([
      "createUser",
      "deleteUser",
      "readUsers",
      "request",
    ]);
  });
});
