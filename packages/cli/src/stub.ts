// stub.ts — `suss stub` command implementation
//
// Generates BehavioralSummary[] from a declared contract source rather than
// from TypeScript code. Each --from value maps to a tiny loader that knows
// how to turn a file path into summaries; future stub kinds (GraphQL SDL,
// gRPC proto, etc.) plug in the same way.

import fs from "node:fs";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type StubSource = "openapi" | "cloudformation" | "storybook" | "appsync";

export interface StubOptions {
  from: StubSource;
  spec: string;
  output?: string;
}

type StubLoader = (specPath: string) => Promise<BehavioralSummary[]>;

const STUB_LOADERS: Record<StubSource, StubLoader> = {
  openapi: async (specPath) => {
    const mod = await import("@suss/stub-openapi");
    return mod.openApiFileToSummaries(specPath);
  },
  cloudformation: async (specPath) => {
    const mod = await import("@suss/stub-cloudformation");
    return mod.cloudFormationFileToSummaries(specPath);
  },
  storybook: async (specPath) => {
    // `--from storybook` accepts a single `.stories.ts[x]` file path or
    // a glob pattern that resolves to one or more stories files. The
    // stub reads CSF3 shape and emits one summary per named story.
    const mod = await import("@suss/stub-storybook");
    const files = expandStoryPaths(specPath);
    return mod.generateSummariesFromStories(files);
  },
  appsync: async (specPath) => {
    // `--from appsync` reads a CFN / SAM template with AWS::AppSync::*
    // resources and emits one summary per resolver with
    // graphql-resolver semantics.
    const mod = await import("@suss/stub-appsync");
    return mod.appsyncFileToSummaries(specPath);
  },
};

function expandStoryPaths(spec: string): string[] {
  // Check if it's a direct file path first. If the path exists on
  // disk, use it — simplest and covers the single-file case.
  const absolute = path.resolve(spec);
  if (fs.existsSync(absolute)) {
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      return [absolute];
    }
    if (stat.isDirectory()) {
      // Directory — walk for `.stories.ts[x]` files (one level of
      // recursion; callers can pass a deeper subdirectory if they
      // want finer scope).
      return walkForStoryFiles(absolute);
    }
  }
  // Not an existing path: treat it as a shell-expanded list of paths
  // (the shell usually does glob expansion before we see it). When
  // the shell has passed multiple files, the caller would typically
  // invoke us once per file; we surface a useful error otherwise.
  throw new Error(
    `No stories found at "${spec}". Pass a .stories.ts[x] file or a directory containing them.`,
  );
}

function walkForStoryFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (/\.stories\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    } else if (entry.isDirectory()) {
      out.push(...walkForStoryFiles(full));
    }
  }
  return out;
}

export async function stub(options: StubOptions): Promise<BehavioralSummary[]> {
  const loader = STUB_LOADERS[options.from];
  if (loader === undefined) {
    throw new Error(
      `Unknown stub source: "${options.from}". Supported: ${Object.keys(STUB_LOADERS).join(", ")}`,
    );
  }

  const summaries = await loader(options.spec);

  const json = JSON.stringify(summaries, null, 2);

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`);
    process.stderr.write(
      `Wrote ${summaries.length} stub summaries to ${outPath}\n`,
    );
  } else {
    process.stdout.write(`${json}\n`);
  }

  return summaries;
}
