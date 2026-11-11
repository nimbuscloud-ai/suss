import { describe, expect, it } from "vitest";

import { effectsOverFile, packWithOnly } from "@suss/pack-harness";
import { createTestProject } from "@suss/test-project";

import nodeRuntimePack from "./index.js";
import { compiledReads, runtimeReadMatches } from "./runtimeReads.js";

import type { Effect } from "@suss/behavioral-ir";
import type { SourceFile } from "ts-morph";

function makeFile(source: string): SourceFile {
  const project = createTestProject();
  return project.createSourceFile("user.ts", source);
}

/** The chains over `process`, `import.meta` and the module globals. */
function runRecognizers(file: SourceFile): Effect[] {
  return effectsOverFile(
    file,
    packWithOnly(nodeRuntimePack(), {
      access: compiledReads(runtimeReadMatches({}).rest),
    }),
  );
}

function metadataReadsOf(effects: Effect[]) {
  return effects.filter(
    (e) => e.type === "interaction" && e.interaction.class === "metadata-read",
  ) as Array<
    Extract<Effect, { type: "interaction" }> & {
      interaction: { class: "metadata-read" };
    }
  >;
}

describe("module-surface recognizers", () => {
  it("recognizes import.meta.url", () => {
    const file = makeFile(`
      const here = import.meta.url;
    `);
    const reads = metadataReadsOf(runRecognizers(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction.name).toBe("import.meta.url");
  });

  it("leaves import.meta.env to the environment reader", () => {
    const file = makeFile(`
      const api = import.meta.env.VITE_API_URL;
      const env = import.meta.env;
    `);
    expect(runRecognizers(file)).toEqual([]);
  });

  it("says nothing about a deployment, since nothing supplies a module's location", () => {
    const file = makeFile(`
      const here = import.meta.url;
      const a = __dirname.length;
    `);
    const reads = metadataReadsOf(runRecognizers(file));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.binding.semantics).toEqual({ name: "runtime-config" });
    }
  });

  it("reports a module location as metadata rather than as a config read", () => {
    const file = makeFile(`
      const here = import.meta.url;
      const a = __dirname.length;
    `);
    const classes = runRecognizers(file).map((e) =>
      e.type === "interaction" ? e.interaction.class : e.type,
    );
    expect(classes).toEqual(["metadata-read", "metadata-read"]);
  });

  it("recognizes __dirname / __filename when accessed as a property receiver", () => {
    const file = makeFile(`
      const a = __dirname.length;
      const b = __filename.length;
    `);
    const reads = metadataReadsOf(runRecognizers(file));
    const names = reads.map((r) => r.interaction.name).sort();
    expect(names).toEqual(["__dirname", "__filename"]);
  });
});
