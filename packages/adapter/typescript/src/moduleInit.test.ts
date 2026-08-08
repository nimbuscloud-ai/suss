/**
 * What a module does when it loads is behavior no unit body contains,
 * and the walk that finds it has to stop where the module stops running.
 */

import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { moduleInitSummary } from "./moduleInit.js";
import { runAccessRecognizersAtModuleScope } from "./resolve/invocationEffects.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

/**
 * A stand-in for the node pack's env recognizer. The adapter dispatches
 * to whatever a pack supplies, so the test supplies its own rather than
 * leaning on a real pack to decide where the walk goes.
 */
const configReadRecognizer: AccessRecognizer = (access) => {
  const node = access as Node;
  if (!Node.isPropertyAccessExpression(node)) {
    return null;
  }
  const owner = node.getExpression();
  if (owner.getText() !== "settings") {
    return null;
  }
  return [
    {
      type: "interaction",
      binding: runtimeConfigBinding({
        recognition: "test",
        deploymentTarget: "lambda",
        instanceName: "<unknown>",
      }),
      callee: node.getText(),
      interaction: {
        class: "config-read",
        name: node.getName(),
        defaulted: false,
      },
    },
  ];
};

function moduleOf(source: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("/service/config.ts", source);
}

function summaryOf(source: string): BehavioralSummary | null {
  const file = moduleOf(
    `declare const settings: Record<string, string>;\n${source}`,
  );
  const effects = runAccessRecognizersAtModuleScope(file, [
    configReadRecognizer,
  ]).map((recognized) => recognized.effect);
  return moduleInitSummary(file, effects);
}

function varsRead(summary: BehavioralSummary | null): string[] {
  if (summary === null) {
    return [];
  }
  return summary.transitions
    .flatMap((transition) => transition.effects ?? [])
    .flatMap((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "config-read"
        ? [effect.interaction.name]
        : [],
    )
    .sort();
}

describe("what a module reads when it loads", () => {
  it("reports a read in a top-level statement", () => {
    expect(varsRead(summaryOf("const url = settings.SERVICE_URL;"))).toEqual([
      "SERVICE_URL",
    ]);
  });

  it("reports every read the module performs", () => {
    const summary = summaryOf(`
      const a = settings.ALPHA;
      const b = settings.BETA;
    `);
    expect(varsRead(summary)).toEqual(["ALPHA", "BETA"]);
  });

  it("leaves a read inside a function to the unit that runs it", () => {
    expect(
      varsRead(summaryOf("const read = () => settings.SERVICE_URL;")),
    ).toEqual([]);
  });

  it("leaves a read inside a callback the module passes along", () => {
    expect(
      varsRead(
        summaryOf(`
          declare function register(fn: () => string): void;
          register(() => settings.SERVICE_URL);
        `),
      ),
    ).toEqual([]);
  });

  it("leaves a read inside a class to the member that performs it", () => {
    expect(
      varsRead(
        summaryOf(`
          class Config {
            url() { return settings.SERVICE_URL; }
          }
        `),
      ),
    ).toEqual([]);
  });

  it("produces no summary for a module that reads nothing", () => {
    expect(summaryOf("export const name = 'config';")).toBeNull();
  });

  it("names the unit after the file and claims no boundary of its own", () => {
    const summary = summaryOf("const url = settings.SERVICE_URL;");
    expect(summary?.kind).toBe("module-init");
    expect(summary?.identity.name).toBe("config.ts");
    expect(summary?.identity.boundaryBinding).toBeNull();
    expect(summary?.location.file).toBe("/service/config.ts");
  });

  it("reports one read once, whatever else the module declares", () => {
    const summary = summaryOf(`
      const url = settings.SERVICE_URL;
      export function first() { return url; }
      export function second() { return url; }
    `);
    expect(varsRead(summary)).toEqual(["SERVICE_URL"]);
  });
});
