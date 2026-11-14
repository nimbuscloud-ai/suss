import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { readSitesOf } from "./readSites.js";

/** The text of each read site on the first call to `decode` in the source. */
function sitesIn(body: string): string[] {
  const project = createTestProject();
  const file = project.createSourceFile(
    "/handler.ts",
    [
      "declare function decode(text: string): any;",
      "declare function use(...values: unknown[]): void;",
      "export function handler(text: string) {",
      body,
      "}",
    ].join("\n"),
  );
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((one) => one.getExpression().getText() === "decode");
  if (call === undefined) {
    throw new Error("the source calls no decode");
  }
  return readSitesOf(call).map((site) => site.getText());
}

describe("readSitesOf", () => {
  it("finds the reads on the value and on every reference to the name it is kept in", () => {
    expect(
      sitesIn(
        [
          "  const order = decode(text) as { id: string };",
          "  if (order.flag) use(order.id, order['kind']);",
          "  const { lines, 'full-name': label } = order;",
          "  use(lines, label);",
        ].join("\n"),
      ),
    ).toEqual([
      "order.flag",
      "order.id",
      "order['kind']",
      "lines",
      "'full-name': label",
    ]);
  });

  it("finds a read off the call itself, past parentheses and a cast", () => {
    expect(sitesIn("  use((decode(text) as { kind: string }).kind);")).toEqual([
      "(decode(text) as { kind: string }).kind",
    ]);
  });

  it("leaves out a callee, an assignment's target, a rest element and a computed key", () => {
    expect(
      sitesIn(
        [
          "  const key = 'region';",
          "  const { id, [key]: region, ...rest } = decode(text);",
          "  use(id, region, rest);",
        ].join("\n"),
      ),
    ).toEqual(["id"]);
    expect(
      sitesIn(
        [
          "  const order = decode(text);",
          "  order.seen = true;",
          "  use(order.toString(), order.lines.length);",
        ].join("\n"),
      ),
    ).toEqual(["order.lines"]);
  });

  it("doesn't follow a name written again", () => {
    expect(
      sitesIn(
        [
          "  let order = decode(text);",
          "  order = null;",
          "  use(order.id);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
