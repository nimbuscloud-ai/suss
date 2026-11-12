import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { factCallOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { declarationBehind } from "./declarationBehind.js";
import { factSourceFor, statedFactKey } from "./factSource.js";

/** Where each value handed to `use` is declared, in source order. */
function declaredUses(files: Record<string, string>): unknown[] {
  const project = createTestProject();
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const store = new ResolutionStore();
  return (
    project
      .getSourceFile("/use.tsx")
      ?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []
  )
    .filter((call) => call.getExpression().getText() === "use")
    .map((call) => {
      const [argument] = call.getArguments();
      return argument === undefined
        ? undefined
        : declarationBehind(argument, store);
    });
}

describe("where a value is declared", () => {
  it("follows an import through a renaming barrel, a default export and a parenthesized name to the module that writes it", () => {
    expect(
      declaredUses({
        "/chip.tsx": "export function Chip() { return null; }",
        "/index.ts": 'export { Chip as Badge } from "./chip";',
        "/divider.tsx": "export default () => null;",
        "/wrapped.tsx":
          "const Wrapped = () => null;\nexport default (Wrapped);",
        "/anonymous.tsx": "export default function () { return null; }",
        "/loop.tsx": 'import Loop from "./loop";\nexport default (Loop);',
        "/use.tsx": [
          'import { Badge } from "./index";',
          'import Divider from "./divider";',
          'import Wrapped from "./wrapped";',
          'import Anonymous from "./anonymous";',
          'import Loop from "./loop";',
          'import { Gone } from "not-installed";',
          "use(Badge);",
          "use(Divider);",
          "use(Wrapped);",
          "use(Anonymous);",
          "use(Loop);",
          "use(Gone);",
        ].join("\n"),
      }),
    ).toEqual([
      { file: "/chip.tsx", name: "Chip" },
      { file: "/divider.tsx", name: null },
      { file: "/wrapped.tsx", name: "Wrapped" },
      { file: "/anonymous.tsx", name: null },
      null,
      null,
    ]);
  });

  it("gives a declaration in the file itself, a parameter with no name, and nothing for a value that is no name", () => {
    expect(
      declaredUses({
        "/use.tsx": [
          "class Local {}",
          "function read(param: unknown) {",
          "  use(param);",
          "}",
          "use(Local);",
          "use(() => null);",
        ].join("\n"),
      }),
    ).toEqual([
      { file: "/use.tsx", name: null },
      { file: "/use.tsx", name: "Local" },
      null,
    ]);
  });

  it("follows a member read off an object a module writes out, written with type arguments too, through the value ops", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/internal/CardRoot.tsx",
      "export const CardRoot = (props: { title: string }) => null;",
    );
    project.createSourceFile(
      "/internal/SliderRoot.tsx",
      "export function SliderRoot<T>(props: { value: T }) { return null; }",
    );
    project.createSourceFile(
      "/card.ts",
      [
        'import { CardRoot } from "./internal/CardRoot";',
        'import { SliderRoot } from "./internal/SliderRoot";',
        "export const Card = { Root: CardRoot };",
        "export const Slider = { Root: SliderRoot };",
      ].join("\n"),
    );
    const file = project.createSourceFile(
      "/use.tsx",
      [
        'import { Card, Slider } from "./card";',
        "use({ card: Card.Root, slider: Slider.Root<number>, missing: Card.Missing });",
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const [call] = file.getDescendantsOfKind(SyntaxKind.CallExpression);
    const written =
      call === undefined
        ? null
        : factCallOps(statedFactKey(call, store), factSourceFor(store))
            ?.valueAt(0)
            ?.object?.();

    expect(
      ["card", "slider", "missing"].map(
        (name) => written?.property(name)?.declaration?.() ?? null,
      ),
    ).toEqual([
      { file: "/internal/CardRoot.tsx", name: "CardRoot" },
      { file: "/internal/SliderRoot.tsx", name: "SliderRoot" },
      null,
    ]);
  });

  it("is what the value ops over the fact source say, beside the JSX a function writes", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/chip.tsx",
      "export function Chip(props: { label: string }) { return null; }",
    );
    const file = project.createSourceFile(
      "/use.tsx",
      [
        'import { Chip } from "./chip";',
        'use(Chip, (args: { label: string }) => <Chip {...args} size="md" />);',
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const [call] = file.getDescendantsOfKind(SyntaxKind.CallExpression);
    const ops =
      call === undefined
        ? null
        : factCallOps(statedFactKey(call, store), factSourceFor(store));
    const render = ops?.valueAt(1)?.function?.() ?? null;
    const [chip] = render?.elements?.("Chip") ?? [];

    expect(ops?.valueAt(0)?.declaration?.()).toEqual({
      file: "/chip.tsx",
      name: "Chip",
    });
    expect(chip?.props()).toEqual(["size"]);
    expect(
      chip
        ?.spreads()
        .map((spread) =>
          render === null ? null : spread.parameterAt?.(render),
        ),
    ).toEqual([0]);
    expect(chip?.hasChildren()).toBe(false);
  });
});
