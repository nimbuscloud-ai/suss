// A call the walk cannot follow is only worth a gap when the callee is
// code the project wrote. Each test lays out one callee shape and asks
// what the closure would say about it.

import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import {
  classifyStop,
  declarationsBehind,
  unfollowedCallGap,
  worthRecording,
} from "./unfollowedCall.js";

/**
 * Every declaration the type checker offers for the callee of the last
 * call written in `/use.ts`, which is what the closure hands the
 * classifier once it has failed to reach a body through any of them.
 */
function calleeDeclarations(files: Record<string, string>): Node[] {
  const project = createTestProject();
  for (const [path, contents] of Object.entries(files)) {
    project.createSourceFile(path, contents);
  }
  const calls = project
    .getSourceFileOrThrow("/use.ts")
    .getDescendants()
    .filter(Node.isCallExpression);
  const last = calls[calls.length - 1];
  if (last === undefined) {
    throw new Error("No call expression in /use.ts");
  }
  return declarationsBehind(last.getExpression().getSymbol());
}

describe("classifyStop", () => {
  it("calls a method the project declares on an interface a declaration with no body", () => {
    const declarations = calleeDeclarations({
      "/dao.ts": `
        export interface EditionDao {
          getEditions(id: string): Promise<string[]>;
        }
      `,
      "/use.ts": `
        import type { EditionDao } from "./dao";
        export class Service {
          constructor(private readonly dao: EditionDao) {}
          list(id: string) { return this.dao.getEditions(id); }
        }
      `,
    });

    expect(classifyStop(declarations)).toBe("noBody");
  });

  it("calls an abstract method a declaration with no body", () => {
    const declarations = calleeDeclarations({
      "/use.ts": `
        abstract class Base {
          abstract run(id: string): void;
          go(id: string) { this.run(id); }
        }
      `,
    });

    expect(classifyStop(declarations)).toBe("noBody");
  });

  it("calls an ambient declaration a declaration with no body", () => {
    const declarations = calleeDeclarations({
      "/globals.ts": `
        declare function projectGlobal(id: string): void;
        export {};
      `,
      "/use.ts": `
        declare function projectGlobal(id: string): void;
        export function go(id: string) { projectGlobal(id); }
      `,
    });

    expect(classifyStop(declarations)).toBe("noBody");
  });

  it("calls a parameter a value that was never settled", () => {
    const declarations = calleeDeclarations({
      "/use.ts": `
        export function go(next: (id: string) => void, id: string) {
          next(id);
        }
      `,
    });

    expect(classifyStop(declarations)).toBe("unsettledValue");
  });

  it("calls a field a value that was never settled", () => {
    const declarations = calleeDeclarations({
      "/use.ts": `
        export class Service {
          private readonly run: (id: string) => void = () => {};
          go(id: string) { this.run(id); }
        }
      `,
    });

    expect(classifyStop(declarations)).toBe("unsettledValue");
  });

  it("calls something on an untyped value a callee nothing declares", () => {
    const declarations = calleeDeclarations({
      "/use.ts": `
        export function go(res: any) {
          res.status(400).json({ error: "no" });
        }
      `,
    });

    expect(declarations).toHaveLength(0);
    expect(classifyStop(declarations)).toBe("noDeclaration");
  });

  it("calls a function an ambient module declaration describes a package whose source is not in this run", () => {
    const declarations = calleeDeclarations({
      "/use.ts": `
        declare module "shipped" {
          export function send(id: string): void;
        }
        import { send } from "shipped";
        export function go(id: string) { send(id); }
      `,
    });

    expect(classifyStop(declarations)).toBe("outsideRun");
  });

  it("calls into a dependency a package whose source is not in this run", () => {
    const declarations = calleeDeclarations({
      "/node_modules/dep/index.d.ts": `
        export declare function fromDep(id: string): void;
      `,
      "/use.ts": `
        import { fromDep } from "dep";
        export function go(id: string) { fromDep(id); }
      `,
    });

    expect(classifyStop(declarations)).toBe("outsideRun");
  });

  it("calls a dependency's function through a project barrel a package whose source is not in this run", () => {
    const declarations = calleeDeclarations({
      "/node_modules/dep/index.d.ts": `
        export declare function fromDep(id: string): void;
      `,
      "/barrel.ts": `
        export { fromDep } from "dep";
      `,
      "/use.ts": `
        import { fromDep } from "./barrel";
        export function go(id: string) { fromDep(id); }
      `,
    });

    expect(classifyStop(declarations)).toBe("outsideRun");
  });

  it("calls a method a dependency declares on an interface a package whose source is not in this run", () => {
    const declarations = calleeDeclarations({
      "/node_modules/dep/index.d.ts": `
        export interface Client { send(id: string): void; }
      `,
      "/use.ts": `
        import type { Client } from "dep";
        export function go(client: Client, id: string) { client.send(id); }
      `,
    });

    expect(classifyStop(declarations)).toBe("outsideRun");
  });
});

describe("worthRecording", () => {
  it("records a stop on code the project wrote", () => {
    expect(worthRecording("noBody")).toBe(true);
    expect(worthRecording("unsettledValue")).toBe(true);
  });

  it("leaves out a stop in a dependency, which the run describes as a crossing", () => {
    expect(worthRecording("outsideRun")).toBe(false);
  });

  it("leaves out a call on an untyped value, which says nothing about who owns the callee", () => {
    expect(worthRecording("noDeclaration")).toBe(false);
  });
});

describe("unfollowedCallGap", () => {
  it("says which call stopped the walk and why", () => {
    const gap = unfollowedCallGap({
      callee: "this.dao.getEditions",
      reason: "noBody",
    });

    expect(gap.type).toBe("unfollowedCall");
    expect(gap.consequence).toBe("unknown");
    expect(gap.description).toContain("this.dao.getEditions");
    expect(gap.description).toContain("no body");
  });

  it("tells an unsettled value apart from a declaration with no body", () => {
    const gap = unfollowedCallGap({ callee: "next", reason: "unsettledValue" });

    expect(gap.description).toContain("could not settle");
  });
});
