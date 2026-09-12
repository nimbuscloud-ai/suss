/**
 * A frontend whose components all go through one project hook, run
 * through the built binary.
 *
 * Nothing in the fixture calls `useQuery` directly. The operations are
 * written in the components, the hook is two files away, and one of the
 * components is two wrappers and a barrel away from Apollo.
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
  "../../../fixtures/apollo-client/wrapped-hooks",
);

let summaries: BehavioralSummary[];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-wrapped-hooks-"));
  const output = path.join(dir, "summaries.json");
  const extract = spawnSync(
    process.execPath,
    [
      BIN,
      "extract",
      "--dir",
      FIXTURE,
      "-f",
      "apollo-client",
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

function operationsByName(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const summary of summaries) {
    const semantics = summary.identity.boundaryBinding?.semantics;
    if (semantics?.name !== "graphql-operation") {
      continue;
    }
    found[summary.identity.name] =
      `${semantics.operationType} ${semantics.operationName ?? "<anon>"} in ${path.basename(summary.location.file)}`;
  }
  return found;
}

describe("a frontend that wraps Apollo's hooks in one of its own", () => {
  it("reports one operation per component, in the component's file", () => {
    expect(operationsByName()).toMatchObject({
      "Profile.Profile": "query Profile in profile.tsx",
      "SettingsPanel.Settings": "query Settings in settings.tsx",
      "CreateWidget.CreateWidget": "mutation CreateWidget in createWidget.tsx",
      "LegacyPanel.LegacyOrders": "query LegacyOrders in legacyPanel.tsx",
    });
  });

  it("reports nothing for the wrapper every one of those callers went through", () => {
    expect(
      Object.keys(operationsByName()).filter(
        (name) =>
          name.startsWith("useAppQuery.") ||
          name.startsWith("useAppMutation.") ||
          name.startsWith("useLegacyQuery."),
      ),
    ).toEqual([]);
  });

  it("keeps the wrapper nothing in the run calls, and says why", () => {
    const orphan = summaries.find((summary) =>
      summary.identity.name.startsWith("usePublicSubscription."),
    );
    expect(
      (orphan?.metadata as { graphql?: { unresolvedDocument?: unknown } })
        ?.graphql?.unresolvedDocument,
    ).toEqual({
      reference: "document",
      reason:
        "the document argument is this function's parameter, and no call of the function was found in the files read",
    });
  });

  it("reports the component whose document is decided at run time as a gap", () => {
    const dashboard = summaries.find((summary) =>
      summary.identity.name.startsWith("Dashboard."),
    );
    expect(
      (dashboard?.metadata as { graphql?: { unresolvedDocument?: unknown } })
        ?.graphql?.unresolvedDocument,
    ).toMatchObject({ reference: "preferWeekly ? WEEKLY_QUERY : DAILY_QUERY" });
  });
});
