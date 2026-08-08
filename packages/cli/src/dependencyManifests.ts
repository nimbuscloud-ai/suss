// dependencyManifests.ts: the libraries a Python or Ruby project says
// it depends on, and the places suss looked and could not tell.
//
// package.json answers this question in one line of JSON.parse. The
// other two ecosystems do not. A requirements file has a grammar
// (extras, version specifiers, environment markers, URL installs, and
// includes pointing at further files), pyproject spells the same list
// three ways depending on which tool wrote it, and setup.py and Gemfile
// are programs that compute their answer rather than stating it.
//
// So every reader here answers in two parts: the names it read, and the
// files or lines it could not read, with why. A project whose manifest
// suss cannot read is a project suss cannot suggest packs for, and
// saying that is the whole point. Suggesting nothing looks the same as
// finding nothing.

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

/** A library a project depends on, and the file that said so. */
export interface DeclaredDependency {
  /** Normalized library name: lower case, with `_` and `.` written as `-`. */
  name: string;
  /** The manifest that named it, relative to the project root. */
  where: string;
}

/** Somewhere suss looked for dependencies and could not read one. */
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

/**
 * PEP 503 normalization, which is what makes `Flask-RESTX`,
 * `flask_restx`, and `flask.restx` one library rather than three.
 */
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

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/** Requirements files as they are actually named in the wild. */
const REQUIREMENTS_FILES = [
  "requirements.txt",
  "requirements.in",
  "requirements-dev.txt",
  "requirements-test.txt",
];

/**
 * What every Python packaging file in this project says, read in the
 * order the files are common: requirements files first, then pyproject,
 * then the declarative and program-shaped stragglers.
 */
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

/**
 * One requirements file, and any file it includes with `-r` or `-c`.
 *
 * The parser reads the whole file at once and refuses all of it when
 * one line is outside the grammar, which a bare VCS URL or a pip
 * setting like `--index-url` is. So a file that will not parse whole is
 * read a line at a time: the lines that state a library still count,
 * and the ones that do not are reported rather than dropped.
 */
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

/** One logical line of a requirements file. */
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

  // An editable install points at a directory whose own pyproject or
  // setup.py states the libraries, so the name is not on this line to
  // be read.
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
    // A pip setting states no library and hides nothing, so it is not
    // worth reporting; anything else on a line suss cannot parse is.
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

/** Follow an include, or report it when the file it names is missing. */
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
  // `name @ https://...` states the library name before the URL, which
  // is all suss needs.
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

/**
 * pyproject states dependencies in whichever spelling the tool that
 * wrote it uses, so all three are read: the standard `project`
 * dependencies, and Poetry's own two tables.
 */
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

  // A project whose dependencies are computed at build time states
  // that, so suss can say it looked rather than say there were none.
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
      // Poetry states the interpreter itself in the same table.
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
 * setup.cfg is setup.py's declarative sibling, and mostly its
 * `install_requires` is a list of requirement lines. setuptools also
 * lets it point somewhere else, at a file (`file: requirements.txt`) or
 * at an attribute of the package itself (`attr: mypkg.__requires__`),
 * and then the list is no more written here than a computed one in
 * setup.py is.
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
 * setup.py is a program. Where it hands `install_requires` a list
 * written out in the file, that list is as good as a manifest; where it
 * hands it anything else, the answer exists only once Python has run,
 * and suss says so rather than reporting an empty list.
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

/**
 * The requirement strings `install_requires` is handed, when they are
 * written out rather than computed.
 */
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
  // Anything in the list other than the strings themselves means part
  // of it is computed, and the part suss can see is not the whole.
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

/** The library a PEP 508 requirement string names, when it names one. */
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

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

/**
 * What a Ruby project says it depends on.
 *
 * A Gemfile is Ruby, and its gem list can be built by a loop, a
 * conditional, or a call into another file, so suss reads Gemfile.lock,
 * which bundler writes out and which states the same direct
 * dependencies as data. A project with no lock file gets told that.
 */
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

/**
 * The gems a lock file names as this project's own, which is what its
 * DEPENDENCIES section holds. The GEM section below it lists everything
 * those gems pulled in as well, and suggesting a pack for a library
 * this project never asked for would be a worse answer.
 */
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
