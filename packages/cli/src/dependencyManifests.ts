/**
 * The libraries a Python or Ruby project says it depends on, and the
 * places suss looked and could not tell.
 *
 * For package.json this is one call to JSON.parse. The other two
 * ecosystems are harder: requirements files have a whole grammar,
 * pyproject spells the same list three ways depending on which tool
 * wrote it, and setup.py and Gemfile are programs that compute their
 * dependencies rather than listing them. The README has a table of
 * what each format takes to read.
 *
 * So each reader returns two things, the names it managed to read and
 * the files it could not, because coming back with no suggestions looks
 * exactly like finding nothing to suggest.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { parsePipRequirementsLine } from "pip-requirements-js";

import {
  absentReading,
  unreadableReading,
  writtenReading,
} from "@suss/extractor";

import type { Reading } from "@suss/extractor";
import type { Requirement } from "pip-requirements-js";

export interface DeclaredDependency {
  /** Normalized library name: lower case, with `_` and `.` written as `-`. */
  name: string;
  /** The manifest that listed it, relative to the project root. */
  where: string;
}

export interface UnreadDependencies {
  /** The file, relative to the project root. */
  where: string;
  /** Why it could not be read, as a sentence a person can act on. */
  reason: string;
}

export interface DeclaredDependencies {
  named: DeclaredDependency[];
  unread: UnreadDependencies[];
}

/** PEP 503 normalization. */
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const empty = (): DeclaredDependencies => ({ named: [], unread: [] });

function merge(parts: DeclaredDependencies[]): DeclaredDependencies {
  return {
    named: parts.flatMap((part) => part.named),
    unread: parts.flatMap((part) => part.unread),
  };
}

const REQUIREMENTS_FILES = [
  "requirements.txt",
  "requirements.in",
  "requirements-dev.txt",
  "requirements-test.txt",
];

export function readPythonDependencies(root: string): DeclaredDependencies {
  const parts: DeclaredDependencies[] = [];

  for (const name of REQUIREMENTS_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      parts.push(readRequirementsFile(root, file, new Set()));
    }
  }

  const pyproject = path.join(root, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    parts.push(readPyproject(root, pyproject));
  }

  const pipfile = path.join(root, "Pipfile");
  if (fs.existsSync(pipfile)) {
    parts.push(readPipfile(root, pipfile));
  }

  const setupCfg = path.join(root, "setup.cfg");
  if (fs.existsSync(setupCfg)) {
    parts.push(readSetupCfg(root, setupCfg));
  }

  const setupPy = path.join(root, "setup.py");
  if (fs.existsSync(setupPy)) {
    parts.push(readSetupPy(root, setupPy));
  }

  for (const name of ["environment.yml", "environment.yaml"]) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      parts.push({
        named: [],
        unread: [
          {
            where: name,
            reason:
              "suss does not read a conda environment file, so any library named only here is invisible to it. Name the packs you want with -f.",
          },
        ],
      });
    }
  }

  return merge(parts);
}

/** Follows `-r` and `-c` includes. */
function readRequirementsFile(
  root: string,
  file: string,
  visited: Set<string>,
): DeclaredDependencies {
  const resolved = path.resolve(file);
  if (visited.has(resolved)) {
    return empty();
  }
  visited.add(resolved);

  const where = path.relative(root, resolved);
  let contents: string;
  try {
    contents = fs.readFileSync(resolved, "utf8");
  } catch {
    return {
      named: [],
      unread: [{ where, reason: "suss could not open this file." }],
    };
  }

  const lines = joinContinuations(contents);
  const parts: DeclaredDependencies[] = [];

  for (const line of lines) {
    parts.push(readRequirementLine(root, resolved, where, line, visited));
  }
  return merge(parts);
}

function readRequirementLine(
  root: string,
  file: string,
  where: string,
  line: string,
  visited: Set<string>,
): DeclaredDependencies {
  const text = line.trim();
  if (text === "" || text.startsWith("#")) {
    return empty();
  }

  // An editable install points at a directory, not at a library.
  if (text.startsWith("-e ") || text.startsWith("--editable ")) {
    return {
      named: [],
      unread: [
        {
          where,
          reason: `\`${text}\` installs from a path rather than naming a library, so suss reads nothing from it.`,
        },
      ],
    };
  }

  let requirement: Requirement | null;
  try {
    requirement = parsePipRequirementsLine(text);
  } catch {
    // A pip setting is not a library, so skipping it hides nothing.
    if (text.startsWith("-")) {
      return empty();
    }
    return {
      named: [],
      unread: [
        {
          where,
          reason: `\`${text}\` states no library name suss can read. A URL or version-control install names its library inside the archive rather than on the line.`,
        },
      ],
    };
  }

  if (requirement === null) {
    return empty();
  }
  return READ_REQUIREMENT[requirement.type]({
    requirement,
    root,
    file,
    where,
    visited,
  });
}

interface RequirementContext<T extends Requirement = Requirement> {
  requirement: T;
  root: string;
  file: string;
  where: string;
  visited: Set<string>;
}

function followInclude(
  context: RequirementContext<
    Extract<Requirement, { type: "RequirementsFile" | "ConstraintsFile" }>
  >,
): DeclaredDependencies {
  const included = context.requirement.path;
  const target = path.resolve(path.dirname(context.file), included);
  if (!fs.existsSync(target)) {
    return {
      named: [],
      unread: [
        {
          where: context.where,
          reason: `it includes ${included}, and there is no such file here.`,
        },
      ],
    };
  }
  return readRequirementsFile(context.root, target, context.visited);
}

type ReadRequirementTable = {
  [K in Requirement["type"]]: (
    context: RequirementContext<Extract<Requirement, { type: K }>>,
  ) => DeclaredDependencies;
};

const READ_REQUIREMENT_TABLE: ReadRequirementTable = {
  ProjectName: ({ requirement, where }) => ({
    named: [{ name: normalizePythonName(requirement.name), where }],
    unread: [],
  }),
  // `name @ https://...` gives the library name before the URL.
  ProjectURL: ({ requirement, where }) => ({
    named: [{ name: normalizePythonName(requirement.name), where }],
    unread: [],
  }),
  RequirementsFile: followInclude,
  ConstraintsFile: followInclude,
};

const READ_REQUIREMENT = READ_REQUIREMENT_TABLE as Record<
  Requirement["type"],
  (context: RequirementContext) => DeclaredDependencies
>;

/** Requirements files let a line continue onto the next with a trailing `\`. */
function joinContinuations(contents: string): string[] {
  const joined: string[] = [];
  let carried = "";
  for (const raw of contents.split(/\r?\n/)) {
    const line = carried + raw;
    if (line.endsWith("\\")) {
      carried = line.slice(0, -1);
      continue;
    }
    carried = "";
    joined.push(line);
  }
  if (carried !== "") {
    joined.push(carried);
  }
  return joined;
}

type TomlTable = Record<string, unknown>;

function tableAt(value: unknown, ...keys: string[]): TomlTable | null {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") {
      return null;
    }
    current = (current as TomlTable)[key];
  }
  return current !== null && typeof current === "object"
    ? (current as TomlTable)
    : null;
}

/** pyproject spells dependencies three ways: standard, and Poetry's two. */
function readPyproject(root: string, file: string): DeclaredDependencies {
  const where = path.relative(root, file);
  let parsed: unknown;
  try {
    parsed = parseToml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      named: [],
      unread: [{ where, reason: `it is not valid TOML: ${message}` }],
    };
  }

  const named: DeclaredDependency[] = [];
  const unread: UnreadDependencies[] = [];

  const project = tableAt(parsed, "project");
  const dependencies = project?.dependencies;
  if (Array.isArray(dependencies)) {
    for (const entry of dependencies) {
      if (typeof entry !== "string") {
        continue;
      }
      const name = nameOfRequirement(entry);
      if (name === null) {
        unread.push({
          where,
          reason: `\`${entry}\` under [project] states no library name suss can read.`,
        });
        continue;
      }
      named.push({ name, where });
    }
  }

  // Dependencies marked dynamic are computed at build time, so suss
  // reports that it looked rather than that there were none.
  const dynamic = project?.dynamic;
  if (Array.isArray(dynamic) && dynamic.includes("dependencies")) {
    unread.push({
      where,
      reason:
        "it declares its dependencies dynamic, so the list is built by the build backend rather than written here.",
    });
  }

  for (const table of ["dependencies", "dev-dependencies"]) {
    const poetry = tableAt(parsed, "tool", "poetry", table);
    if (poetry === null) {
      continue;
    }
    for (const key of Object.keys(poetry)) {
      // Poetry lists the interpreter in the same table as the libraries.
      if (key === "python") {
        continue;
      }
      named.push({ name: normalizePythonName(key), where });
    }
  }

  return { named, unread };
}

/** Pipfile is TOML, and its `packages` tables are keyed by library name. */
function readPipfile(root: string, file: string): DeclaredDependencies {
  const where = path.relative(root, file);
  let parsed: unknown;
  try {
    parsed = parseToml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      named: [],
      unread: [{ where, reason: `it is not valid TOML: ${message}` }],
    };
  }

  const named: DeclaredDependency[] = [];
  for (const table of ["packages", "dev-packages"]) {
    const packages = tableAt(parsed, table);
    if (packages === null) {
      continue;
    }
    for (const key of Object.keys(packages)) {
      named.push({ name: normalizePythonName(key), where });
    }
  }
  return { named, unread: [] };
}

/**
 * setup.cfg's `install_requires`, which is usually requirement lines
 * but may point at a file or a package attribute instead.
 */
function readSetupCfg(root: string, file: string): DeclaredDependencies {
  const where = path.relative(root, file);
  const contents = fs.readFileSync(file, "utf8");
  const match = contents.match(
    /^\s*install_requires\s*=([^\n]*)\n((?:[ \t]+\S[^\n]*\n?)*)/m,
  );
  if (match === null) {
    return empty();
  }

  const lines = [match[1] ?? "", ...(match[2] ?? "").split(/\r?\n/)];
  const named: DeclaredDependency[] = [];
  const unread: UnreadDependencies[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) {
      continue;
    }

    const directive = text.match(/^(file|attr):\s*(.*)$/);
    if (directive !== null) {
      unread.push({
        where,
        reason: `its install_requires reads \`${text}\`, so the libraries it names are ${directive[1] === "file" ? "in another file setuptools reads at build time" : "an attribute of the package, known only once Python has imported it"}. Name the packs you want with -f.`,
      });
      continue;
    }

    const name = nameOfRequirement(text);
    if (name === null) {
      unread.push({
        where,
        reason: `\`${text}\` under install_requires states no library name suss can read.`,
      });
      continue;
    }
    named.push({ name, where });
  }
  return { named, unread };
}

/**
 * setup.py is a program, so only an `install_requires` list written out
 * in the file can be read.
 */
function readSetupPy(root: string, file: string): DeclaredDependencies {
  const where = path.relative(root, file);
  const reading = readInstallRequires(fs.readFileSync(file, "utf8"));

  type ReadingTable = {
    [K in Reading<string[]>["kind"]]: (
      reading: Extract<Reading<string[]>, { kind: K }>,
    ) => DeclaredDependencies;
  };

  const table: ReadingTable = {
    absent: () => empty(),
    written: (written) => ({
      named: written.value
        .map(nameOfRequirement)
        .filter((name): name is string => name !== null)
        .map((name) => ({ name, where })),
      unread: [],
    }),
    unreadable: (unreadable) => ({
      named: [],
      unread: [{ where, reason: unreadable.reason }],
    }),
    ambiguous: (ambiguous) => ({
      named: [],
      unread: [{ where, reason: ambiguous.reason }],
    }),
  };

  const read = table[reading.kind] as (
    reading: Reading<string[]>,
  ) => DeclaredDependencies;
  return read(reading);
}

export function readInstallRequires(source: string): Reading<string[]> {
  const keyword = source.match(/install_requires\s*=/);
  if (keyword?.index === undefined) {
    return absentReading;
  }

  const start = keyword.index;
  const after = source.slice(start + keyword[0].length);
  const openedAt = after.search(/\S/);
  const range = { start, end: start + keyword[0].length };

  if (openedAt === -1 || after[openedAt] !== "[") {
    return unreadableReading(
      "its install_requires is computed rather than written out, so the libraries it names exist only once Python has run it. Add a requirements.txt or a pyproject.toml, or name the packs you want with -f.",
      range,
    );
  }

  const close = after.indexOf("]", openedAt);
  if (close === -1) {
    return unreadableReading(
      "its install_requires opens a list that never closes, so suss could not read it.",
      range,
    );
  }

  const inside = after.slice(openedAt + 1, close);
  const strings = [...inside.matchAll(/["']([^"']*)["']/g)].map(
    (match) => match[1] ?? "",
  );
  // A non-string element means part of the list is computed, so what
  // suss can see here is not the whole list.
  const leftover = inside
    .replace(/["'][^"']*["']/g, "")
    .replace(/[\s,]/g, "")
    .replace(/#[^\n]*/g, "");
  if (leftover !== "") {
    return unreadableReading(
      "its install_requires list is partly built at run time, so suss cannot tell which libraries it ends up naming.",
      { start, end: start + keyword[0].length + close },
    );
  }

  return writtenReading(strings, {
    start,
    end: start + keyword[0].length + close,
  });
}

function nameOfRequirement(requirement: string): string | null {
  try {
    const parsed = parsePipRequirementsLine(requirement.trim());
    if (parsed === null || !("name" in parsed)) {
      return null;
    }
    return normalizePythonName(parsed.name);
  } catch {
    return null;
  }
}

/** Read from Gemfile.lock: the Gemfile itself is a program. */
export function readRubyDependencies(root: string): DeclaredDependencies {
  const lock = path.join(root, "Gemfile.lock");
  if (fs.existsSync(lock)) {
    return readGemfileLock(root, lock);
  }

  if (fs.existsSync(path.join(root, "Gemfile"))) {
    return {
      named: [],
      unread: [
        {
          where: "Gemfile",
          reason:
            "a Gemfile is a Ruby program, so the gems it ends up naming are known only once bundler has run it. suss reads Gemfile.lock instead, and there is none here. Commit the lock file, or name the packs you want with -f.",
        },
      ],
    };
  }

  return empty();
}

/** DEPENDENCIES only, because the GEM section below it also contains
 * transitive gems the project never asked for. */
function readGemfileLock(root: string, file: string): DeclaredDependencies {
  const where = path.relative(root, file);
  const contents = fs.readFileSync(file, "utf8");
  const named: DeclaredDependency[] = [];

  let inside = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inside = line.trim() === "DEPENDENCIES";
      continue;
    }
    if (!inside) {
      continue;
    }
    const gem = line.trim().match(/^([A-Za-z0-9_.-]+)/);
    if (gem?.[1] !== undefined) {
      named.push({ name: gem[1], where });
    }
  }

  return { named, unread: [] };
}
