/**
 * The suss side of the client URL check. Each case becomes one function
 * making one call, in a small project for its language. The built CLI
 * extracts each project with the packs of the libraries in it, and each
 * client summary is read back as the method, host and path it records,
 * keyed by the function it was written in.
 *
 * The TypeScript project links the harness's own axios install, because
 * the axios pack recognizes a client by its type.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSummaryFile } from "@suss/behavioral-ir/files";

import {
  HOLE_NAME,
  type Library,
  type NetHttpForm,
  type UrlCase,
} from "./cases.js";
import { failureOf } from "./failure.js";

export interface SussRequest {
  readonly method: string | null;
  readonly host: string | null;
  readonly path: string | null;
}

/** The requests suss records per case id, or why the language's extract failed. */
export type SussSide =
  | { readonly ok: true; readonly requests: ReadonlyMap<string, SussRequest[]> }
  | { readonly ok: false; readonly error: string };

type Language = "python" | "ruby" | "typescript";

const LANGUAGE_OF: Record<Library, Language> = {
  httpx: "python",
  aiohttp: "python",
  faraday: "ruby",
  "net-http": "ruby",
  axios: "typescript",
};

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOLE = `{${HOLE_NAME}}`;

function hasHole(c: UrlCase): boolean {
  return c.path.includes(HOLE);
}

function pythonString(text: string): string {
  return text.includes(HOLE)
    ? `f${JSON.stringify(text)}`
    : JSON.stringify(text);
}

function rubyString(text: string): string {
  return JSON.stringify(text).replaceAll(HOLE, `#${HOLE}`);
}

function typescriptString(text: string): string {
  return text.includes(HOLE)
    ? `\`${text.replaceAll(HOLE, `$${HOLE}`)}\``
    : JSON.stringify(text);
}

function rubyArguments(...values: readonly (string | number | null)[]): string {
  return values
    .filter((value) => value !== null)
    .map((value) =>
      typeof value === "number" ? String(value) : rubyString(value),
    )
    .join(", ");
}

function rubyHostAndPort(c: UrlCase): string {
  return rubyArguments(c.base ?? "", c.port);
}

type Render = (c: UrlCase) => string;

const NET_HTTP_FORMS: Record<NetHttpForm, Render> = {
  get: (c) => `  Net::HTTP.get(${rubyArguments(c.base ?? "", c.path, c.port)})`,
  new: (c) =>
    `  http = Net::HTTP.new(${rubyHostAndPort(c)})\n  http.get(${rubyString(c.path)})`,
  request: (c) =>
    `  http = Net::HTTP.new(${rubyHostAndPort(c)})\n  http.request(Net::HTTP::Get.new(${rubyString(c.path)}))`,
  uri: (c) => `  Net::HTTP.get(URI(${rubyString(c.path)}))`,
};

const CALLS: Record<Library, Render> = {
  httpx: (c) =>
    c.base === null
      ? `    return httpx.get(${pythonString(c.path)})`
      : `    client = httpx.Client(base_url=${pythonString(c.base)})\n    return client.get(${pythonString(c.path)})`,
  aiohttp: (c) => {
    const options = c.base === null ? "" : `base_url=${pythonString(c.base)}`;
    return `    async with aiohttp.ClientSession(${options}) as session:\n        return await session.get(${pythonString(c.path)})`;
  },
  faraday: (c) =>
    c.base === null
      ? `  Faraday.get(${rubyString(c.path)})`
      : `  conn = Faraday.new(url: ${rubyString(c.base)})\n  conn.get(${rubyString(c.path)})`,
  "net-http": (c) => NET_HTTP_FORMS[c.form ?? "get"](c),
  axios: (c) =>
    c.base === null
      ? `  return axios.get(${typescriptString(c.path)});`
      : `  const client = axios.create({ baseURL: ${typescriptString(c.base)} });\n  return client.get(${typescriptString(c.path)});`,
};

const FUNCTIONS: Record<Language, (c: UrlCase, body: string) => string> = {
  python: (c, body) => {
    const keyword = c.library === "aiohttp" ? "async def" : "def";
    return `${keyword} ${c.id}(${hasHole(c) ? HOLE_NAME : ""}):\n${body}\n`;
  },
  ruby: (c, body) =>
    `def ${c.id}${hasHole(c) ? `(${HOLE_NAME})` : ""}\n${body}\nend\n`,
  typescript: (c, body) =>
    `export function ${c.id}(${hasHole(c) ? `${HOLE_NAME}: string` : ""}) {\n${body}\n}\n`,
};

const IMPORTS: Record<Library, string> = {
  httpx: "import httpx\n",
  aiohttp: "import aiohttp\n",
  faraday: 'require "faraday"\n',
  "net-http": 'require "net/http"\nrequire "uri"\n',
  axios: 'import axios from "axios";\n',
};

const EXTENSIONS: Record<Language, string> = {
  python: "py",
  ruby: "rb",
  typescript: "ts",
};

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2022",
  },
  include: ["src"],
};

function writeProject(
  dir: string,
  language: Language,
  cases: readonly UrlCase[],
): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const libraries = [...new Set(cases.map((c) => c.library))];
  for (const library of libraries) {
    const functions = cases
      .filter((c) => c.library === library)
      .map((c) => FUNCTIONS[language](c, CALLS[library](c)));
    fs.writeFileSync(
      path.join(
        dir,
        "src",
        `${library.replace("-", "_")}Cases.${EXTENSIONS[language]}`,
      ),
      [IMPORTS[library], ...functions].join("\n"),
    );
  }

  if (language === "typescript") {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
    fs.symlinkSync(
      path.join(HARNESS_ROOT, "node", "node_modules"),
      path.join(dir, "node_modules"),
    );
  }
}

function cliBin(): string {
  const entry = fileURLToPath(import.meta.resolve("@suss/cli"));
  return path.join(path.dirname(entry), "bin.js");
}

function extract(dir: string, packs: readonly string[]): SussSide {
  const out = path.join(dir, "summaries.json");
  const run = spawnSync(
    process.execPath,
    [
      cliBin(),
      "extract",
      ...packs.flatMap((pack) => ["-f", pack]),
      "--dir",
      path.join(dir, "src"),
      "-o",
      out,
      "--cache-dir",
      path.join(dir, ".cache"),
    ],
    { encoding: "utf8" },
  );
  const failure = failureOf(run);
  if (failure !== null) {
    return {
      ok: false,
      error: `suss extract -f ${packs.join(" -f ")} failed: ${failure}`,
    };
  }

  const requests = new Map<string, SussRequest[]>();
  for (const summary of readSummaryFile(out)) {
    if (summary.kind !== "client") {
      continue;
    }

    const semantics = summary.identity.boundaryBinding?.semantics;
    const rest = semantics?.name === "rest" ? semantics : null;
    const ofCase = requests.get(summary.identity.name) ?? [];
    ofCase.push({
      method: rest?.method ?? null,
      host: rest?.host ?? null,
      path: rest?.path ?? null,
    });
    requests.set(summary.identity.name, ofCase);
  }

  return { ok: true, requests };
}

/** Writes and extracts one project per language under `workDir`. */
export function runSussSide(
  cases: readonly UrlCase[],
  workDir: string,
): Map<Library, SussSide> {
  const sides = new Map<Library, SussSide>();
  for (const language of ["python", "ruby", "typescript"] as const) {
    const ofLanguage = cases.filter((c) => LANGUAGE_OF[c.library] === language);
    if (ofLanguage.length === 0) {
      continue;
    }

    const dir = path.join(workDir, language);
    writeProject(dir, language, ofLanguage);
    const packs = [...new Set(ofLanguage.map((c) => c.library))];
    const side = extract(dir, packs);
    for (const library of packs) {
      sides.set(library, side);
    }
  }

  return sides;
}
