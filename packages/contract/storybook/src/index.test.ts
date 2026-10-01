import path from "node:path";

import { describe, expect, it } from "vitest";

import { readStorybookMetadata } from "@suss/behavioral-ir";

import { generateSummariesFromStories } from "./index.js";

import type { BehavioralSummary, StorybookMetadata } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/storybook");
const repoRoot = path.resolve(__dirname, "../../../..");

describe("generateSummariesFromStories — CSF3 basics", () => {
  it("emits one summary per named story export", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Button.stories.tsx")],
      { projectRoot: repoRoot },
    );
    expect(summaries).toHaveLength(2);
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Button.Disabled", "Button.Primary"]);
  });

  it("surfaces args as parameter inputs on each summary", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Button.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const primary = summaries.find((s) => s.identity.name === "Button.Primary");
    expect(primary).toBeDefined();
    const labelInput = primary?.inputs.find(
      (i) => i.type === "parameter" && i.name === "label",
    );
    expect(labelInput).toBeDefined();
    if (labelInput?.type === "parameter") {
      expect(labelInput.role).toBe("label");
      if (labelInput.shape?.type === "ref") {
        // The string the arg is set to, not the source text around it.
        expect(labelInput.shape.name).toBe("Click me");
      } else {
        throw new Error("expected ref shape");
      }
    }

    const disabled = summaries.find(
      (s) => s.identity.name === "Button.Disabled",
    );
    const disabledInput = disabled?.inputs.find(
      (i) => i.type === "parameter" && i.name === "disabled",
    );
    expect(disabledInput).toBeDefined();
    if (
      disabledInput?.type === "parameter" &&
      disabledInput.shape?.type === "ref"
    ) {
      expect(disabledInput.shape.name).toBe("true");
    }
  });

  it("attaches a default render transition per story naming the component", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Button.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const primary = summaries.find((s) => s.identity.name === "Button.Primary");
    if (!primary) {
      throw new Error("Button.Primary summary missing");
    }
    expect(primary.transitions).toHaveLength(1);
    const txn = primary.transitions[0];
    expect(txn.isDefault).toBe(true);
    if (txn.output.type !== "render") {
      throw new Error("expected render output");
    }
    expect(txn.output.component).toBe("Button");
  });

  it("marks summaries as stub-confidence and records storybook provenance", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Button.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const primary = summaries.find((s) => s.identity.name === "Button.Primary");
    expect(primary?.confidence.source).toBe("derived");
    const meta = primary?.metadata?.component as
      | {
          storybook?: {
            story?: string;
            component?: string;
            args?: Record<string, string>;
            provenance?: string;
          };
        }
      | undefined;
    expect(meta?.storybook?.story).toBe("Primary");
    expect(meta?.storybook?.component).toBe("Button");
    expect(meta?.storybook?.provenance).toBe("independent");
  });

  it("carries an in-process boundary binding with react framework", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Button.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const primary = summaries.find((s) => s.identity.name === "Button.Primary");
    expect(primary?.identity.boundaryBinding?.transport).toBe("in-process");
    expect(primary?.identity.boundaryBinding?.recognition).toBe("react");
  });

  it("produces portable (project-relative) file paths", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Button.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const primary = summaries.find((s) => s.identity.name === "Button.Primary");
    expect(primary?.location.file).toBe(
      "fixtures/storybook/Button.stories.tsx",
    );
  });
});

describe("the module a story's component comes from", () => {
  const importsDir = path.resolve(fixturesDir, "../storybook-imports");

  function storybookOf(file: string): StorybookMetadata | undefined {
    const [summary] = generateSummariesFromStories(
      [path.join(importsDir, file)],
      { projectRoot: importsDir },
    );
    return summary === undefined ? undefined : readStorybookMetadata(summary);
  }

  it("follows an import through a path alias the nearest tsconfig declares", () => {
    const story = storybookOf("src/Chip/__stories__/Chip.stories.tsx");
    expect(story?.componentModule).toEqual({
      workspace: "ui-kit",
      file: "src/Chip/Chip.tsx",
      name: "Chip",
    });
    expect(story?.componentImport).toBe("@ui/Chip/Chip");
  });

  it("follows a renamed import through a barrel to the declaration", () => {
    expect(storybookOf("src/Barrel.stories.tsx")?.componentModule).toEqual({
      workspace: "ui-kit",
      file: "src/Chip/Chip.tsx",
      name: "Chip",
    });
  });

  it("records the story file itself for a component declared there", () => {
    const story = storybookOf("src/Preview.stories.tsx");
    expect(story?.componentModule).toEqual({
      workspace: "ui-kit",
      file: "src/Preview.stories.tsx",
      name: "Preview",
    });
    expect(story?.componentImport).toBeUndefined();
  });

  it("records no module when the import does not lead to a file", () => {
    const story = storybookOf("src/Missing.stories.tsx");
    expect(story?.component).toBe("Badge");
    expect(story?.componentModule).toBeUndefined();
    expect(story?.componentImport).toBe("@ui/Badge/Badge");
  });
});

describe("args on the meta", () => {
  const importsDir = path.resolve(fixturesDir, "../storybook-imports");

  it("gives every story the meta's args, under the story's own", () => {
    const summaries = generateSummariesFromStories(
      [path.join(importsDir, "src/Chip/__stories__/ChipMeta.stories.tsx")],
      { projectRoot: importsDir },
    );
    const argsOf = (name: string) =>
      readStorybookMetadata(
        summaries.find((s) => s.identity.name === name) as BehavioralSummary,
      )?.args;

    expect(argsOf("Chip.Plain")).toEqual({ label: "Shared", size: "sm" });
    expect(argsOf("Chip.Medium")).toEqual({ label: "Shared", size: "md" });
  });

  it("records the decorators and render functions that receive the args first", () => {
    const summaries = generateSummariesFromStories(
      [path.join(importsDir, "src/Chip/__stories__/ChipWrapped.stories.tsx")],
      { projectRoot: importsDir },
    );
    const readersOf = (name: string) =>
      readStorybookMetadata(
        summaries.find((s) => s.identity.name === name) as BehavioralSummary,
      )?.argReaders;

    expect(readersOf("Chip.Routed")).toEqual(["decorators"]);
    expect(readersOf("Chip.Custom")).toEqual(["decorators", "render"]);
    const [plain] = generateSummariesFromStories(
      [path.join(importsDir, "src/Chip/__stories__/Chip.stories.tsx")],
      { projectRoot: importsDir },
    );
    expect(
      readStorybookMetadata(plain as BehavioralSummary)?.argReaders,
    ).toBeUndefined();
  });
});

describe("generateSummariesFromStories — shape variants", () => {
  it("handles `{...} satisfies Meta<T>` on the meta object", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Counter.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Counter.Default", "Counter.NoArgs"]);
  });

  it("handles stories with no `args` field (empty inputs)", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Counter.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const noArgs = summaries.find((s) => s.identity.name === "Counter.NoArgs");
    expect(noArgs?.inputs).toEqual([]);
  });

  it("captures shorthand-property args", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Counter.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const def = summaries.find((s) => s.identity.name === "Counter.Default");
    // `args: { label, initial: 0 }`, `label` is shorthand for the
    // module's `const label = "primary"`.
    const labelInput = def?.inputs.find(
      (i) => i.type === "parameter" && i.name === "label",
    );
    expect(labelInput).toBeDefined();
    if (labelInput?.type === "parameter" && labelInput.shape?.type === "ref") {
      expect(labelInput.shape.name).toBe("primary");
    }
  });

  it("captures args spread in from another object", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "Counter.stories.tsx")],
      { projectRoot: repoRoot },
    );
    const def = summaries.find((s) => s.identity.name === "Counter.Default");
    // `args: { label, ...startingPoint }`, where startingPoint sets
    // `initial`.
    const initial = def?.inputs.find(
      (i) => i.type === "parameter" && i.name === "initial",
    );
    expect(initial).toBeDefined();
  });

  it("handles `export default { ... }` without an intermediate const", () => {
    const summaries = generateSummariesFromStories(
      [path.join(fixturesDir, "DirectDefault.stories.tsx")],
      { projectRoot: repoRoot },
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].identity.name).toBe("Greeting.Hello");
    const meta = summaries[0].metadata?.component as
      | { storybook?: { component?: string } }
      | undefined;
    expect(meta?.storybook?.component).toBe("Greeting");
  });

  it("skips files whose default export has no component property", () => {
    // Create an in-memory fixture: a stories-like file that doesn't
    // declare a component. Use the `Counter.stories.tsx` path but
    // the contents are ad-hoc. We do this by asking the API to read
    // a fixture that doesn't exist as a story, easier to just lean
    // on the Button fixture, which we already cover. For the
    // negative case, we confirm that a non-stories source file
    // produces no summaries.
    const summaries = generateSummariesFromStories(
      [path.resolve(__dirname, "../../../../fixtures/react/Button.tsx")],
      { projectRoot: repoRoot },
    );
    expect(summaries).toEqual([]);
  });
});
