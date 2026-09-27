import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { Effect, ProvenanceEntry, ValueRef } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { TsInvocationRecognizerContext } from "./resolve/invocationEffects.js";

/** A store in miniature: `save(tenant, id)` writes `tenant` to the row picked by `id`. */
const savingPack: PatternPack = {
  name: "saving",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["handler"] } },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "allPositional" },
  invocationRecognizers: [
    (_call, ctx) => {
      const { ops } = ctx as TsInvocationRecognizerContext;
      if (ops?.calleeText() !== "save") {
        return null;
      }
      const effect: Effect = {
        type: "interaction",
        binding: storageBinding({
          recognition: "saving",
          storageSystem: "postgresql",
          scope: "default",
          container: "orders",
        }),
        callee: "save",
        interaction: {
          class: "storage-access",
          kind: "write",
          fields: ["tenant"],
          selector: ["id"],
        },
      };
      const tenant = ops.valueAt(0);
      const id = ops.valueAt(1);
      ops.statesSlots?.(effect, [
        ...(tenant === null
          ? []
          : [{ slot: "field" as const, name: "tenant", value: tenant }]),
        ...(id === null
          ? []
          : [{ slot: "selector" as const, name: "id", value: id }]),
      ]);
      return [effect];
    },
  ],
};

interface SlotSource {
  slot: string;
  name: string;
  kind: string | null;
  from: ValueRef[];
}

/** Each entry, with the class of the effect its slot points at in place of the index. */
async function provenanceOf(source: string): Promise<SlotSource[]> {
  const project = createTestProject();
  project.createSourceFile("handler.ts", source);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [savingPack],
  });
  const summaries = await adapter.extractAll();
  const handler = summaries.find((one) => one.identity.name === "handler");
  return (handler?.transitions ?? []).flatMap((t) =>
    (t.provenance ?? []).map(({ at, from }: ProvenanceEntry) => {
      const effect = t.effects[at.effect];
      const kind =
        effect?.type === "interaction" ? effect.interaction.class : null;
      return { slot: at.slot, name: at.name, kind, from };
    }),
  );
}

describe("where a written or selected value came from", () => {
  it("follows a value to the unit's parameter and to a literal", async () => {
    const entries = await provenanceOf(`
      declare function save(tenant: unknown, id: unknown): void;
      export function handler(event: { auth: { tenant: string } }) {
        const tenant = event.auth.tenant;
        save(tenant, 7);
        return 1;
      }
    `);
    expect(entries).toEqual([
      {
        slot: "field",
        name: "tenant",
        kind: "storage-access",
        from: [{ type: "input", inputRef: "event", path: ["auth", "tenant"] }],
      },
      {
        slot: "selector",
        name: "id",
        kind: "storage-access",
        from: [{ type: "literal", value: 7 }],
      },
    ]);
  });

  it("writes a destructured parameter under the name it binds", async () => {
    const entries = await provenanceOf(`
      declare function save(tenant: unknown, id: unknown): void;
      export function handler({ tenant }: { tenant: string }, key: string) {
        save(tenant, key);
        return 1;
      }
    `);
    expect(entries.map((entry) => entry.from)).toEqual([
      [{ type: "input", inputRef: "tenant", path: [] }],
      [{ type: "input", inputRef: "key", path: [] }],
    ]);
  });

  it("quotes where the walk stopped when it reaches something it cannot follow", async () => {
    const entries = await provenanceOf(`
      declare function save(tenant: unknown, id: unknown): void;
      declare function lookUp(): string;
      export function handler() {
        save(lookUp(), "x");
        return 1;
      }
    `);
    expect(entries[0]?.from).toEqual([
      { type: "unresolved", sourceText: "lookUp()" },
    ]);
  });
});
