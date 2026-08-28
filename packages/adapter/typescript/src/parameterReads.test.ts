import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { parameterReads } from "./parameterReads.js";

import type { FunctionRoot } from "./conditions.js";

function functionNamed(source: string, name: string): FunctionRoot {
  const project = createTestProject();
  const file = project.createSourceFile("/probe.tsx", source);
  return file.getFunctionOrThrow(name) as unknown as FunctionRoot;
}

describe("parameterReads", () => {
  it("records the property chain read off a whole parameter", () => {
    const func = functionNamed(
      `
      function Card(props: { user: { name: string } }) {
        return <div>{props.user.name}</div>;
      }
    `,
      "Card",
    );
    expect(parameterReads(func, ["props"])).toEqual([
      { input: "props", path: ["user", "name"] },
    ]);
  });

  it("records a bare read of a destructured binding once", () => {
    const func = functionNamed(
      `
      function Avatar({ src }: { src: string }) {
        return <img src={src} alt={src} />;
      }
    `,
      "Avatar",
    );
    expect(parameterReads(func, ["src"])).toEqual([{ input: "src", path: [] }]);
  });

  it("reads a string element access as a path segment and stops at a dynamic one", () => {
    const func = functionNamed(
      `
      function Pick(props: Record<string, string>, key: string) {
        return props["title"] + props[key];
      }
    `,
      "Pick",
    );
    expect(parameterReads(func, ["props"])).toEqual(
      expect.arrayContaining([
        { input: "props", path: ["title"] },
        { input: "props", path: [] },
      ]),
    );
  });

  it("never attributes a shadowing inner binding to the parameter", () => {
    const func = functionNamed(
      `
      function Outer(props: { a: string }) {
        const inner = (props: { b: string }) => props.b;
        return inner({ b: props.a });
      }
    `,
      "Outer",
    );
    expect(parameterReads(func, ["props"])).toEqual([
      { input: "props", path: ["a"] },
    ]);
  });
});
