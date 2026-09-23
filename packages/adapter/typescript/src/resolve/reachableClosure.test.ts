// Each case lays out one callee shape the syntax cannot settle, runs the
// adapter from an entry `run`, and checks that the function behind the
// callee gets a summary and the call leaves no gap.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack, TransparentWrapper } from "@suss/extractor";

function entryPack(wrappers: TransparentWrapper[] = []): PatternPack {
  return {
    name: "test-entry",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: [
      { kind: "handler", match: { type: "namedExport", names: ["run"] } },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
    transparentWrappers: wrappers,
  };
}

async function extract(
  files: Record<string, string>,
  wrappers: TransparentWrapper[] = [],
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [path, contents] of Object.entries(files)) {
    project.createSourceFile(path, contents);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [entryPack(wrappers)],
  });
  return await adapter.extractAll();
}

/** The callees the entry `run` stopped at. */
function stopsOnRun(summaries: BehavioralSummary[]): string[] {
  const run = summaries.find((one) => one.identity.name === "run");
  return (run?.gaps ?? []).flatMap((gap) =>
    gap.type === "unfollowedCall" && gap.callee !== undefined
      ? [gap.callee]
      : [],
  );
}

function reached(summaries: BehavioralSummary[], name: string): boolean {
  return summaries.some(
    (one) =>
      one.identity.name === name &&
      one.identity.boundaryBinding?.recognition === "reachable",
  );
}

describe("a callee only the resolution store settles", () => {
  it("follows a function destructured off a factory's returned object", async () => {
    const summaries = await extract({
      "/dialog.ts": `
        export function useDialog() {
          const openDialog = () => { track("open"); };
          return { openDialog };
        }
        export function track(event: string) { return event; }
      `,
      "/entry.ts": `
        import { useDialog } from "./dialog";
        export function run() {
          const { openDialog } = useDialog();
          openDialog();
        }
      `,
    });

    expect(stopsOnRun(summaries)).toEqual([]);
    expect(reached(summaries, "openDialog")).toBe(true);
    expect(reached(summaries, "track")).toBe(true);
  });

  it("follows a name written as a factory call to the function it handed back", async () => {
    const summaries = await extract({
      "/nav.ts": `
        export const useNavigator = () => (url: string) => { visit(url); };
        export function visit(url: string) { return url; }
      `,
      "/entry.ts": `
        import { useNavigator } from "./nav";
        export function run() {
          const navigate = useNavigator();
          navigate("/orders");
        }
      `,
    });

    expect(stopsOnRun(summaries)).toEqual([]);
    expect(reached(summaries, "visit")).toBe(true);
  });

  it("follows a factory returning a wrapper's call to the function the wrapper unwraps", async () => {
    const summaries = await extract({
      "/guard.ts": `
        export const guard = (fn: (id: number) => void) => (id: number) =>
          Promise.resolve(fn(id)).catch(() => undefined);
        export const useOrders = (table: string) =>
          guard(async (id: number) => { loadRow(table, id); });
        export function loadRow(table: string, id: number) { return { table, id }; }
      `,
      "/entry.ts": `
        import { useOrders } from "./guard";
        export function run() {
          const handler = useOrders("orders");
          handler(1);
        }
      `,
    });

    expect(stopsOnRun(summaries)).toEqual([]);
    expect(reached(summaries, "loadRow")).toBe(true);
  });

  it("follows a function a declared wrapper hands back", async () => {
    const summaries = await extract(
      {
        "/entry.ts": `
          import { keep } from "wrapper-lib";
          export function run() {
            const save = keep(() => { persist("orders"); });
            save();
          }
          function persist(table: string) { return table; }
        `,
      },
      [{ callee: "keep", argument: 0, module: "wrapper-lib" }],
    );

    expect(stopsOnRun(summaries)).toEqual([]);
    expect(reached(summaries, "persist")).toBe(true);
  });

  it("follows the target Object.assign hands back", async () => {
    const summaries = await extract({
      "/card.ts": `
        function Root() { return draw("dim_account"); }
        export const ReportCard = Object.assign(Root, { title: "Accounts" });
        export function draw(table: string) { return table; }
      `,
      "/entry.ts": `
        import { ReportCard } from "./card";
        export function run() { ReportCard(); }
      `,
    });

    expect(stopsOnRun(summaries)).toEqual([]);
    expect(reached(summaries, "Root")).toBe(true);
  });

  it("still records a gap when the store cannot settle the callee either", async () => {
    const summaries = await extract({
      "/entry.ts": `
        const handlers: Record<string, () => void> = {};
        export function run(kind: string) {
          const handler = handlers[kind];
          handler();
        }
      `,
    });

    expect(stopsOnRun(summaries)).toEqual(["handler"]);
  });
});
