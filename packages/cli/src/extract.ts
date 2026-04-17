// extract.ts — `suss extract` command implementation

import fs from "node:fs";
import path from "node:path";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Framework pack resolution
// ---------------------------------------------------------------------------

const BUILTIN_FRAMEWORKS: Record<
  string,
  () => Promise<{ default: () => PatternPack }>
> = {
  "ts-rest": () => import("@suss/framework-ts-rest"),
  "react-router": () => import("@suss/framework-react-router"),
  express: () => import("@suss/framework-express"),
  fastify: () => import("@suss/framework-fastify"),
  fetch: () => import("@suss/runtime-web"),
};

async function resolveFramework(name: string): Promise<PatternPack> {
  const builtin = BUILTIN_FRAMEWORKS[name];
  if (builtin !== undefined) {
    const mod = await builtin();
    return mod.default();
  }

  // Try dynamic import for custom framework packs
  try {
    const mod = (await import(`@suss/framework-${name}`)) as {
      default: () => PatternPack;
    };
    return mod.default();
  } catch {
    throw new Error(
      `Unknown framework: "${name}". Built-in: ${Object.keys(BUILTIN_FRAMEWORKS).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Extract command
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  tsconfig: string;
  frameworks: string[];
  files?: string[];
  output?: string;
  gaps?: "strict" | "permissive" | "silent";
}

export async function extract(
  options: ExtractOptions,
): Promise<BehavioralSummary[]> {
  const tsconfigPath = path.resolve(options.tsconfig);

  if (!fs.existsSync(tsconfigPath)) {
    throw new Error(`tsconfig not found: ${tsconfigPath}`);
  }

  if (options.frameworks.length === 0) {
    throw new Error("At least one framework (-f) is required");
  }

  // Resolve all framework packs
  const packs = await Promise.all(options.frameworks.map(resolveFramework));

  // Build extractor options
  const extractorOptions =
    options.gaps !== undefined ? { gapHandling: options.gaps } : undefined;

  // Create adapter
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: tsconfigPath,
    frameworks: packs,
    ...(extractorOptions !== undefined ? { extractorOptions } : {}),
  });

  // Extract
  const summaries =
    options.files !== undefined && options.files.length > 0
      ? adapter.extractFromFiles(options.files.map((f) => path.resolve(f)))
      : adapter.extractAll();

  // Make file paths relative to the project root so summaries are portable.
  // Absolute paths leak filesystem structure and break on other machines.
  const projectRoot = path.dirname(tsconfigPath);
  for (const summary of summaries) {
    summary.location.file = path.relative(projectRoot, summary.location.file);
  }

  // Output
  const json = JSON.stringify(summaries, null, 2);

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`);
    process.stderr.write(`Wrote ${summaries.length} summaries to ${outPath}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }

  return summaries;
}
