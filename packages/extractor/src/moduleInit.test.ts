import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { assembleSummary } from "./index.js";
import { moduleInitStructure } from "./moduleInit.js";

import type { Effect } from "@suss/behavioral-ir";

const read: Effect = {
  type: "interaction",
  binding: runtimeConfigBinding({
    recognition: "python-env",
    deploymentTarget: "lambda",
    instanceName: "<unknown>",
  }),
  callee: 'os.environ["TABLE_NAME"]',
  interaction: { class: "config-read", name: "TABLE_NAME", defaulted: false },
};

describe("moduleInitStructure", () => {
  it("builds a module-init unit with one void branch that the effects go on", () => {
    const summary = assembleSummary(
      moduleInitStructure({
        name: "app.py",
        file: "src/app.py",
        range: { start: 1, end: 24 },
        effects: [read],
      }),
    );

    expect(summary.kind).toBe("module-init");
    expect(summary.identity.name).toBe("app.py");
    expect(summary.identity.boundaryBinding).toBeNull();
    expect(summary.location).toEqual({
      file: "src/app.py",
      range: { start: 1, end: 24 },
      exportName: null,
    });
    expect(summary.transitions).toHaveLength(1);
    expect(summary.transitions[0]?.output).toEqual({ type: "void" });
    expect(summary.transitions[0]?.effects).toEqual([read]);
  });
});
