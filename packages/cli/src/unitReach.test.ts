import { describe, expect, it } from "vitest";

import { messageBusBinding, storageBinding } from "@suss/behavioral-ir";
import { readCallFacts } from "@suss/checker";

import { touchesOfUnits } from "./target.js";
import { reachedFunctions, touchesReached } from "./unitReach.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

function unit(
  name: string,
  kind: BehavioralSummary["kind"],
  line: number,
  effects: Effect[],
  binding: BehavioralSummary["identity"]["boundaryBinding"] = null,
): BehavioralSummary {
  return {
    kind,
    location: {
      file: "app/report.rb",
      range: { start: line, end: line + 5 },
      exportName: name,
    },
    identity: { name, exportPath: [name], boundaryBinding: binding },
    inputs: [],
    transitions: [
      {
        id: `${name}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects,
        location: { start: line, end: line + 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

const exportRead: Effect = {
  type: "interaction",
  binding: storageBinding({
    recognition: "activerecord",
    storageSystem: "postgresql",
    scope: "default",
    container: "AsyncFileExport",
  }),
  callee: "AsyncFileExport.find",
  interaction: { class: "storage-access", kind: "read", fields: [] },
};

const job = unit(
  "ReportExportJob.perform",
  "consumer",
  20,
  [exportRead],
  messageBusBinding({
    recognition: "activejob",
    messageBus: "activejob",
    channel: "ReportExportJob",
  }),
);

const mutation = unit("resolve", "library", 1, [
  {
    type: "interaction",
    binding: messageBusBinding({
      recognition: "activejob",
      messageBus: "activejob",
      channel: "ReportExportJob",
    }),
    callee: "ReportExportJob.perform_later",
    interaction: { class: "message-send" },
  },
]);

describe("touchesReached", () => {
  it("follows an enqueue into the job and says the job runs later", () => {
    const facts = readCallFacts([mutation, job]);
    const touches = touchesReached(
      touchesOfUnits([mutation]),
      reachedFunctions([mutation], facts),
      facts,
    );
    const read = touches.find(
      (touch) => touch.touched.callee === "AsyncFileExport.find",
    );
    expect(read?.through).toEqual([
      "ReportExportJob.perform_later, which ReportExportJob.perform runs later",
    ]);
  });
});
