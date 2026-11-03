import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { exportedValuesOf } from "./opsOverFacts.js";

const MODULE = `
  const meta = { component: "Chip" };
  export default meta;

  export const Plain = { args: { label: "plain" } };
  export { Plain as Alias };
  export function render() {
    return null;
  }
`;

/** Each export's name, line, and the keys of the object it comes to. */
function exportsOf() {
  const project = createTestProject();
  const file = project.createSourceFile("/module.ts", MODULE);
  const exported = exportedValuesOf(file, new ResolutionStore());
  return [...exported].flatMap(([name, values]) =>
    values.map(({ value, line }) => ({
      name,
      line,
      keys:
        value
          .object?.()
          ?.entries("nothing")
          .map((entry) => entry.key) ?? null,
    })),
  );
}

describe("exportedValuesOf", () => {
  it("gives each export as value ops, with the line its declaration starts on", () => {
    expect(exportsOf()).toEqual([
      { name: "Plain", line: 5, keys: ["args"] },
      { name: "render", line: 7, keys: null },
      { name: "Alias", line: 5, keys: ["args"] },
      { name: "default", line: 2, keys: ["component"] },
    ]);
  });
});
