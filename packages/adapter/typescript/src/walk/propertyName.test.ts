import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import {
  functionNameOf,
  memberNameOf,
  propertyNameOf,
  propertyWrittenAs,
} from "./propertyName.js";

function fileOf(source: string) {
  return createTestProject().createSourceFile("/probe.ts", source);
}

describe("memberNameOf", () => {
  it("gives a literal key its value and a computed key the text written in the brackets", () => {
    const file = fileOf(`
      export class Api {
        plain() {}
        "quoted-name"() {}
        0x10() {}
        [Symbol.iterator]() {}
        "field-name" = 1;
      }
    `);
    const members = file.getClassOrThrow("Api").getMembers();

    expect(
      members.map((member) =>
        memberNameOf(member as Parameters<typeof memberNameOf>[0]),
      ),
    ).toEqual([
      "plain",
      "quoted-name",
      "16",
      "[Symbol.iterator]",
      "field-name",
    ]);
  });

  it("reads the key of an object literal's property assignment", () => {
    const file = fileOf(`export const o = { "a\\"b": () => 1 };`);
    const assignment = file.getFirstDescendantByKindOrThrow(
      SyntaxKind.PropertyAssignment,
    );

    expect(memberNameOf(assignment)).toBe('a"b');
  });
});

describe("functionNameOf", () => {
  it("reads a method by its key and a function declaration by its identifier", () => {
    const file = fileOf(`
      export function declared() {}
      export default function () {}
      export const o = { "quoted-method"() {} };
    `);
    const [declared, anonymous] = file.getFunctions();
    const method = file.getFirstDescendantByKindOrThrow(
      SyntaxKind.MethodDeclaration,
    );

    expect(functionNameOf(declared)).toBe("declared");
    expect(functionNameOf(anonymous)).toBeUndefined();
    expect(functionNameOf(method)).toBe("quoted-method");
  });
});

describe("propertyWrittenAs", () => {
  it("finds a property by the name its key has, whichever way the key is written", () => {
    const file = fileOf(`
      export const o = { plain: 1, "quoted-key": 2, 0x10: 3, short, method() {}, get acc() { return 1; } };
      declare const short: number;
    `);
    const object = file.getFirstDescendantByKindOrThrow(
      SyntaxKind.ObjectLiteralExpression,
    );
    const textOf = (name: string) => propertyWrittenAs(object, name)?.getText();

    expect(textOf("plain")).toBe("plain: 1");
    expect(textOf("quoted-key")).toBe('"quoted-key": 2');
    expect(textOf("16")).toBe("0x10: 3");
    expect(textOf("short")).toBe("short");
    expect(textOf("method")).toBe("method() {}");
    expect(textOf("acc")).toBe("get acc() { return 1; }");
    expect(textOf('"quoted-key"')).toBeUndefined();
    expect(textOf("missing")).toBeUndefined();
  });
});

describe("propertyNameOf", () => {
  it("leaves a computed key without a name", () => {
    const file = fileOf("export const o = { [`a`]: 1, b: 2 };");
    const [computed, plain] = file.getDescendantsOfKind(
      SyntaxKind.PropertyAssignment,
    );

    expect(propertyNameOf(computed)).toBeNull();
    expect(propertyNameOf(plain)).toBe("b");
  });
});
