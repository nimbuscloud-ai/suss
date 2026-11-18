/**
 * The client URL check. For the same base and path, it compares the URL
 * a suss client pack says a request goes to with the URL the library
 * itself builds, for httpx, aiohttp, Faraday, Net::HTTP and axios. The
 * library is asked with nothing sent, and the README says what each
 * library needs installed.
 *
 *   npm run check:client-urls
 *   npx tsx tools/differential/src/client-urls/clientUrls.ts \
 *     [--library httpx]... [--json report.json] [--work-dir dir]
 *
 * Build the CLI first. `--work-dir` keeps the probe projects. The run
 * exits 1 when any case disagrees or a library could not be run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { casesFor, LIBRARIES, type Library, type UrlCase } from "./cases.js";
import { type Comparison, compare } from "./compare.js";
import { type LibraryResult, runLibrarySide } from "./library.js";
import { runSussSide, type SussRequest } from "./suss.js";

interface LibraryReport {
  readonly library: Library;
  /** Why the library or its extract could not be run, or null when both ran. */
  readonly error: string | null;
  readonly comparisons: readonly Comparison[];
}

/** npm runs a workspace script in the workspace, so a relative path is taken from where npm was run. */
function fromInvocation(file: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
}

function isLibrary(name: string): name is Library {
  return (LIBRARIES as readonly string[]).includes(name);
}

function libraryText(result: LibraryResult): string {
  return result.kind === "url" ? result.url : `refused: ${result.reason}`;
}

function sussText(requests: readonly SussRequest[]): string {
  if (requests.length === 0) {
    return "(no request)";
  }

  return requests
    .map((r) => (r.path === null ? "(no path)" : `${r.host ?? ""}${r.path}`))
    .join(", ");
}

function caseText(c: UrlCase): string {
  const port = c.port === null ? "" : `, port ${c.port}`;
  return `base ${JSON.stringify(c.base)}, path ${JSON.stringify(c.path)}${port}`;
}

async function buildReports(
  libraries: readonly Library[],
  workDir: string,
): Promise<LibraryReport[]> {
  const cases = libraries.flatMap(casesFor);
  const librarySides = await runLibrarySide(cases);
  const sussSides = runSussSide(cases, workDir);
  return libraries.map((library) => {
    const librarySide = librarySides.get(library);
    const sussSide = sussSides.get(library);
    if (librarySide === undefined || !librarySide.ok) {
      return {
        library,
        error: librarySide?.error ?? "not run",
        comparisons: [],
      };
    }

    if (sussSide === undefined || !sussSide.ok) {
      return { library, error: sussSide?.error ?? "not run", comparisons: [] };
    }

    const comparisons = cases
      .filter((c) => c.library === library)
      .map((c) => {
        const result = librarySide.results.get(c.id);
        if (result === undefined) {
          throw new Error(`the ${library} probe printed nothing for ${c.id}`);
        }

        return compare(c, result, sussSide.requests.get(c.id) ?? []);
      });
    return { library, error: null, comparisons };
  });
}

function printReport(reports: readonly LibraryReport[]): void {
  for (const report of reports) {
    if (report.error !== null) {
      console.log(`${report.library}: could not run. ${report.error}`);
      continue;
    }

    const disagreeing = report.comparisons.filter(
      (c) => c.disagreement !== null,
    );
    console.log(
      `${report.library}: ${report.comparisons.length} cases, ` +
        `${report.comparisons.length - disagreeing.length} agree, ` +
        `${disagreeing.length} disagree`,
    );
    for (const c of disagreeing) {
      console.log(`  ${c.case.id}: ${caseText(c.case)}`);
      console.log(`    library  ${libraryText(c.library)}`);
      console.log(`    suss     ${sussText(c.suss)}`);
      console.log(`    ${c.disagreement}`);
    }
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      library: { type: "string", multiple: true },
      json: { type: "string" },
      "work-dir": { type: "string" },
    },
  });
  const requested = values.library ?? [...LIBRARIES];
  const unknown = requested.filter((name) => !isLibrary(name));
  if (unknown.length > 0) {
    console.error(
      `Unknown library ${unknown.join(", ")}. Choose from ${LIBRARIES.join(", ")}.`,
    );
    return 2;
  }

  const keep = values["work-dir"];
  const workDir =
    keep === undefined
      ? fs.mkdtempSync(path.join(os.tmpdir(), "suss-client-urls-"))
      : fromInvocation(keep);
  try {
    const reports = await buildReports(requested.filter(isLibrary), workDir);
    printReport(reports);
    if (values.json !== undefined) {
      fs.writeFileSync(
        fromInvocation(values.json),
        `${JSON.stringify(reports, null, 2)}\n`,
      );
    }

    const failed = reports.some(
      (r) =>
        r.error !== null || r.comparisons.some((c) => c.disagreement !== null),
    );
    return failed ? 1 : 0;
  } finally {
    if (keep === undefined) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

process.exitCode = await main();
