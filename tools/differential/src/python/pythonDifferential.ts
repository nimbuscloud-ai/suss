// pythonDifferential.ts: the Python target's end-to-end run.
//
// One batch: render every sampled spec to its own package on disk,
// extract each program through the same pipeline `suss extract` runs
// for Python (tree-sitter parse, binder, router index, the shipped
// pack), observe the whole batch under one interpreter, and judge
// every program's claims against what its app served. The static side and the runtime side
// read the same files on disk, so the two views of a program can
// never drift apart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractPythonProject } from "@suss/adapter-python";
import { fastapiFramework } from "@suss/framework-fastapi";
import { flaskRestxFramework } from "@suss/framework-flask-restx";

import { judgePythonProgram, type PyJudgment } from "./pythonJudge.js";
import {
  assertPythonEnvironment,
  DEFAULT_PYTHON,
  type ObserveManifestEntry,
  observeBatch,
  type ProgramObservation,
} from "./pythonObserve.js";
import {
  type PythonProgramSpec,
  type RenderedPythonProgram,
  renderPythonProgram,
} from "./pythonProgram.js";

import type { PythonPack } from "@suss/adapter-python";
import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface PythonProgramResult {
  spec: PythonProgramSpec;
  rendered: RenderedPythonProgram;
  summaries: BehavioralSummary[];
  observation: ProgramObservation;
  judgment: PyJudgment;
}

export interface PythonBatchResult {
  results: PythonProgramResult[];
}

function packsFor(rendered: RenderedPythonProgram): PythonPack[] {
  if (rendered.framework === "fastapi") {
    return [fastapiFramework()];
  }
  return [flaskRestxFramework({ wrapperModules: rendered.wrapperModules })];
}

function writeProgram(
  batchDir: string,
  programDir: string,
  rendered: RenderedPythonProgram,
): string[] {
  const root = path.join(batchDir, programDir);
  const written: string[] = [];
  for (const [relative, content] of Object.entries(rendered.files)) {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    written.push(filePath);
  }
  return written.sort();
}

/**
 * Render, extract, observe, and judge one batch of sampled specs.
 * Package names are assigned per batch position, so the same spec is
 * reproducible while a batch of programs still imports side by side
 * in one interpreter.
 */
export async function runPythonDifferentialBatch(
  specs: PythonProgramSpec[],
  options: { python?: string } = {},
): Promise<PythonBatchResult> {
  const python = options.python ?? DEFAULT_PYTHON;
  assertPythonEnvironment(python);

  const batchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "suss-differential-python-"),
  );
  try {
    const rendered: RenderedPythonProgram[] = [];
    const summariesPerProgram: BehavioralSummary[][] = [];
    const entries: ObserveManifestEntry[] = [];

    for (const [i, spec] of specs.entries()) {
      const program = renderPythonProgram(spec, `app_${i}`);
      const programDir = `prog_${i}`;
      const files = writeProgram(batchDir, programDir, program);
      const { summaries } = await extractPythonProject({
        files,
        packs: packsFor(program),
        roots: [path.join(batchDir, programDir)],
      });
      rendered.push(program);
      summariesPerProgram.push(summaries);
      entries.push({
        program: programDir,
        packageName: program.packageName,
        framework: program.framework,
        requests: Object.fromEntries(
          program.intents.flatMap((intent) =>
            intent.requestBody !== null
              ? [[intent.name, intent.requestBody]]
              : [],
          ),
        ),
      });
    }

    const observations = observeBatch({ batchDir, entries, python });

    const results: PythonProgramResult[] = specs.map((spec, i) => {
      const observation = observations[i];
      const summaries = summariesPerProgram[i];
      const program = rendered[i];
      return {
        spec,
        rendered: program,
        summaries,
        observation,
        judgment: judgePythonProgram({
          intents: program.intents,
          summaries,
          endpoints: observation.endpoints,
          observationError: observation.error,
        }),
      };
    });

    return { results };
  } finally {
    fs.rmSync(batchDir, { recursive: true, force: true });
  }
}

export function pythonProgramFailed(result: PythonProgramResult): boolean {
  return result.judgment.findings.length > 0;
}

/** Everything a person needs to reproduce and read one failing program. */
export function formatPythonFailure(result: PythonProgramResult): string {
  const lines: string[] = [
    `python differential findings (${result.rendered.framework})`,
    "",
  ];
  for (const finding of result.judgment.findings) {
    lines.push(`${finding.verdict}: ${finding.detail}`);
  }
  lines.push("", "=== files ===");
  for (const [file, content] of Object.entries(result.rendered.files)) {
    if (content === "") {
      continue;
    }
    lines.push(`--- ${file} ---`, content);
  }
  lines.push("=== claims ===");
  for (const summary of result.summaries) {
    lines.push(
      `${summary.identity.name}: ${JSON.stringify(summary.identity.boundaryBinding?.semantics ?? null)}`,
    );
  }
  lines.push("=== observed ===");
  for (const endpoint of result.observation.endpoints) {
    lines.push(
      `${endpoint.method} ${endpoint.path} -> ${endpoint.status} (${endpoint.unit})`,
    );
  }
  if (result.observation.error !== null) {
    lines.push("=== observer error ===", result.observation.error);
  }
  return lines.join("\n");
}
