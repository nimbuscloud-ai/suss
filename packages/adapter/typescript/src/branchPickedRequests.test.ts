import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { fetchRequests } from "./__fixtures__/fetchRequests.js";
import { createTypeScriptAdapter } from "./adapter.js";
import { forkArmCondition, forkTestOf } from "./values/forks.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const fetchPack: PatternPack = {
  name: "fetch",
  protocol: "http",
  languages: ["typescript"],
  discovery: [],
  requestRecognizers: fetchRequests(),
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

async function summariesOf(source: string): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  project.createSourceFile("client.ts", source);
  return createTypeScriptAdapter({
    project,
    frameworks: [fetchPack],
  }).extractAll();
}

/** Each client's request and the condition text of its `when`, by function. */
async function requestsIn(source: string): Promise<string[]> {
  return (await summariesOf(source))
    .filter((summary) => summary.kind === "client")
    .map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      const request =
        semantics?.name === "rest"
          ? `${semantics.method} ${semantics.path}`
          : "";
      const when = (summary.bindingFrom?.when ?? []).map((one) => one.type);
      return `${summary.identity.name}: ${request}${when.length === 0 ? "" : ` when ${when.join(", ")}`}`;
    })
    .sort();
}

describe("a request a branch before the call picks", () => {
  it("is one client per arm, with the arm's condition on the function's own parameter", async () => {
    expect(
      await requestsIn(`
        export async function save(item: { id?: string }) {
          const target = item.id
            ? { method: "PATCH", url: \`/items/\${item.id}\` }
            : { method: "POST", url: "/items" };
          return fetch(target.url, { method: target.method });
        }
      `),
    ).toEqual([
      "save: PATCH /items/{id} when truthinessCheck",
      "save: POST /items when negation",
    ]);
  });

  it("records no condition for a test on a value from around the function", async () => {
    expect(
      await requestsIn(`
        export function makeSave(item?: { id: string }) {
          return async function save() {
            return fetch(item ? \`/items/\${item.id}\` : "/items");
          };
        }
      `),
    ).toEqual(["anonymous: GET /items", "anonymous: GET /items/{id}"]);
  });

  it("is one client per non-falling arm of a switch, its labels as the condition", async () => {
    expect(
      await requestsIn(`
        export async function report(period: string) {
          let path = "/reports/all";
          switch (period) {
            case "day":
              path = "/reports/daily";
              break;
            case "week":
            case "fortnight":
              path = "/reports/weekly";
              break;
            default:
              path = "/reports/other";
          }
          return fetch(path);
        }
      `),
    ).toEqual([
      "report: GET /reports/daily when comparison",
      "report: GET /reports/other",
      "report: GET /reports/weekly when compound",
    ]);
  });

  it("keeps one client when the branch changes nothing the request says", async () => {
    expect(
      await requestsIn(`
        export async function ping(loud: boolean) {
          const body = loud ? "PING" : "ping";
          return fetch("/ping", { method: "POST", body });
        }
      `),
    ).toEqual(["ping: POST /ping"]);
  });

  it("reads a wrapper that picks its request under its one caller's argument, once", async () => {
    const summaries = await summariesOf(`
      export async function send(id?: string) {
        const target = id
          ? { method: "PUT", url: \`/things/\${id}\` }
          : { method: "POST", url: "/things" };
        return fetch(target.url, { method: target.method });
      }
      export async function caller() {
        return send("7");
      }
    `);
    const requests = summaries.map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return `${summary.identity.name} ${semantics?.name === "rest" ? `${semantics.method} ${semantics.path}` : ""}`;
    });
    expect(requests.sort()).toEqual([
      "caller PUT /things/7",
      "send PUT /things/7",
    ]);
  });
});

describe("what a fork tests", () => {
  function forkIn(
    source: string,
    kind: SyntaxKind,
  ): { fork: Node; root: Node } {
    const project = createTestProject();
    const file = project.createSourceFile("fork.ts", source);
    const root = file.getFunctions()[0];
    const fork = root?.getFirstDescendantByKind(kind);
    if (root === undefined || fork === undefined) {
      throw new Error("no fork in the source");
    }
    return { fork, root };
  }

  it("keys a condition by its text, with a leading negation folded", () => {
    const { fork, root } = forkIn(
      "function f(id: string) { if (!(id)) { return 1; } return 2; }",
      SyntaxKind.IfStatement,
    );
    expect(forkTestOf(fork, root)).toEqual({
      key: "id",
      negated: true,
      reads: ["id"],
    });
  });

  it("gives a condition that calls something a key of its own", () => {
    const { fork, root } = forkIn(
      "function f(m: Map<string, string>) { return m.has('a') ? 1 : 2; }",
      SyntaxKind.ConditionalExpression,
    );
    expect(forkTestOf(fork, root)?.key).toMatch(/^m\.has\('a'\)@\d+$/);
  });

  it("gives a condition that reads a name written twice a key of its own", () => {
    const { fork, root } = forkIn(
      "function f(a: boolean) { a = !a; return a ? 1 : 2; }",
      SyntaxKind.ConditionalExpression,
    );
    expect(forkTestOf(fork, root)?.key).toMatch(/^a@\d+$/);
  });

  it("leaves a switch whose clauses fall into each other joined", () => {
    const { fork, root } = forkIn(
      "function f(k: string) { let p = ''; switch (k) { case 'a': p = 'x'; case 'b': p = 'y'; break; } return p; }",
      SyntaxKind.SwitchStatement,
    );
    expect(forkTestOf(fork, root)).toBeNull();
  });

  it("reads a `?:` in parentheses", () => {
    const { fork, root } = forkIn(
      "function f(on: boolean) { return (on ? 'a' : 'b'); }",
      SyntaxKind.ParenthesizedExpression,
    );
    expect(forkTestOf(fork, root)?.key).toBe("on");
    expect(forkArmCondition(fork, 1, root)?.polarity).toBe("negative");
  });

  it("reads a switch arm's label as its condition, and none for its default", () => {
    const { fork, root } = forkIn(
      "function f(k: string) { let p = ''; switch (k) { case 'a': p = 'x'; break; default: p = 'y'; } return p; }",
      SyntaxKind.SwitchStatement,
    );
    expect(Node.isSwitchStatement(fork)).toBe(true);
    expect(forkArmCondition(fork, 0, root)?.sourceText).toBe("k === 'a'");
    expect(forkArmCondition(fork, 1, root)).toBeNull();
  });

  it("reads stacked labels as either one, and no condition for an arm an empty default falls into", () => {
    const { fork, root } = forkIn(
      "function f(k: string) { let p = ''; switch (k) { case 'a': case 'b': p = 'x'; break; default: case 'c': p = 'y'; break; } return p; }",
      SyntaxKind.SwitchStatement,
    );
    expect(forkArmCondition(fork, 0, root)?.structured).toMatchObject({
      type: "compound",
      op: "or",
    });
    expect(forkArmCondition(fork, 0, root)?.sourceText).toBe(
      "k === 'a' || k === 'b'",
    );
    expect(forkArmCondition(fork, 1, root)).toBeNull();
  });
});
