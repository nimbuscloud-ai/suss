// Drizzle integration test: the recognizer through the REAL
// extraction pipeline (not recognizer-in-isolation, which the pack's
// own tests cover).
//
// An Express handler queries Drizzle three ways (builder read, insert,
// update); extraction runs with both packs active and the resulting
// handler summary must have `storage-access` interactions with the
// SQL table names resolved from the schema's `pgTable("...")` calls.
// Unlike the Prisma equivalent, no generate step exists: Drizzle's
// schema IS TypeScript, so the whole fixture lives in memory.

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import drizzleFramework from "@suss/framework-drizzle";
import expressFramework from "@suss/framework-express";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

function makeProject(): Project {
  const project = createTestProject();

  project.createSourceFile(
    "node_modules/drizzle-orm/index.d.ts",
    `
      export interface SelectChain {
        from(table: unknown): SelectChain;
        where(condition: unknown): SelectChain;
      }
      export interface InsertChain { values(v: unknown): InsertChain; }
      export interface UpdateChain {
        set(v: unknown): UpdateChain;
        where(condition: unknown): UpdateChain;
      }
      export interface DrizzleDatabase {
        select(fields?: Record<string, unknown>): SelectChain;
        insert(table: unknown): InsertChain;
        update(table: unknown): UpdateChain;
      }
      export declare function drizzle(client: unknown, config?: unknown): DrizzleDatabase;
      export declare function eq(a: unknown, b: unknown): unknown;
    `,
  );
  project.createSourceFile(
    "node_modules/drizzle-orm/pg-core/index.d.ts",
    `
      export declare function pgTable(name: string, columns: Record<string, unknown>): Record<string, unknown>;
      export declare function serial(name: string): unknown;
      export declare function text(name: string): unknown;
    `,
  );
  project.createSourceFile(
    "/app/schema.ts",
    `
      import { pgTable, serial, text } from "drizzle-orm/pg-core";
      export const accounts = pgTable("accounts", {
        id: serial("id"),
        email: text("email"),
        plan: text("plan"),
      });
    `,
  );
  project.createSourceFile(
    "/app/routes.ts",
    `
      import { Router } from "express";
      import { drizzle, eq } from "drizzle-orm";
      import { accounts } from "./schema.js";
      const router = Router();
      const db = drizzle({});
      router.post("/accounts", async (req, res) => {
        if (!req.body.email) {
          res.status(400).json({ error: "missing email" });
          return;
        }
        await db.insert(accounts).values({ email: req.body.email, plan: "free" });
        const created = await db.select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.email, req.body.email));
        res.status(201).json({ created });
      });
      export default router;
    `,
  );
  return project;
}

function storageInteractions(summary: BehavioralSummary): Effect[] {
  return summary.transitions.flatMap((t) =>
    t.effects.filter(
      (e) => e.type === "interaction" && e.binding.semantics.name === "storage",
    ),
  );
}

describe("drizzle integration", () => {
  it("extracted handler transitions carry storage-access interactions with SQL table names", async () => {
    const adapter = createTypeScriptAdapter({
      project: makeProject(),
      frameworks: [expressFramework(), drizzleFramework()],
      includeReachable: false,
    });
    const summaries = await adapter.extractAll();
    const handler = summaries.find((s) => s.kind === "handler");
    expect(handler).toBeDefined();

    const interactions = storageInteractions(handler as BehavioralSummary);
    expect(interactions.length).toBeGreaterThanOrEqual(2);

    const byOperation = new Map(
      interactions.map((e) => [
        (e as { interaction: { operation: string } }).interaction.operation,
        e,
      ]),
    );

    const insert = byOperation.get("insert");
    expect(insert).toBeDefined();
    if (insert?.type === "interaction") {
      expect(
        insert.binding.semantics.name === "storage" &&
          insert.binding.semantics.container,
      ).toBe("accounts");
      const interaction = insert.interaction as {
        kind: string;
        fields: string[];
      };
      expect(interaction.kind).toBe("write");
      expect(interaction.fields.sort()).toEqual(["email", "plan"]);
    }

    const select = byOperation.get("select");
    expect(select).toBeDefined();
    if (select?.type === "interaction") {
      const interaction = select.interaction as {
        kind: string;
        fields: string[];
        selector?: string[];
      };
      expect(interaction.kind).toBe("read");
      expect(interaction.fields).toEqual(["id"]);
      expect(interaction.selector).toEqual(["email"]);
    }
  });
});
