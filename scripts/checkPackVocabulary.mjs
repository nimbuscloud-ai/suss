#!/usr/bin/env node
// checkPackVocabulary.mjs: a pack may only name identifiers its own
// library defines.
//
// A pack that hardcodes a name some particular codebase chose gives
// every other user false matches, and it inflates coverage measured
// against the codebase the name came from, because discovery finds
// those units by name rather than by pattern. Whether a name is
// legitimate is a judgment only the pack author can make, so the author
// makes it once, in writing, and this check settles the rest: every
// identifier a pack's shipped source names has to appear in that pack's
// vocabulary.json with a note saying where in the library it comes
// from.
//
// Only defaults are policed, and that falls out of the mechanism rather
// than needing a rule: a name a project supplies through `-f pack=
// config.json` reaches the pack at run time and never appears as a
// literal in the pack's source, so this check cannot see it. A name it
// can see is a name the package ships to everyone.
//
// The language adapters get the inverted rule: an adapter's shipped
// source may not contain a string literal that a framework pack's
// vocabulary declares as its library's own name, because that is the
// mechanical signature of library vocabulary living adapter-side
// instead of arriving through a typed pack field. Each adapter is
// matched against the packs that declare a dependency on it; a name in
// another language's pack coinciding with, say, a tree-sitter field
// name is string overlap, not ownership leaking. Entries whose note
// starts with "suss:" name suss's own tags and convention names, which
// both sides legitimately spell, so they are excluded, as are shared-
// vocabulary names and literals shorter than three characters.
//
// Run it with `npm run check:vocabulary`.

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Package families whose members ship pattern packs. */
const PACK_FAMILIES = [
  "framework",
  "client",
  "runtime",
  "contract",
  "terraform",
];

/** Names suss itself defines: IR kinds, roles, protocols, grammar tags. */
const SHARED_VOCABULARY_FILE = path.join(
  ROOT,
  "packages/extractor/vocabulary.json",
);

const VOCABULARY_BASENAME = "vocabulary.json";

/**
 * Fields whose object KEYS are library identifiers. Their values are
 * neutral roles, so the keys are what a scan of string literals alone
 * would miss: they are written as property names, not as strings.
 */
const KEYED_BY_IDENTIFIER = new Set([
  "decoratorRoleMap",
  "methodDecoratorRouteMap",
  "methodDecoratorTypeMap",
  "knownProperties",
  "codes",
  "scalars",
]);

/**
 * Adapter literals shorter than this are not matched: one- and
 * two-character strings ("::", "id") collide with ordinary code too
 * often to signal anything.
 */
const ADAPTER_SCAN_MIN_LENGTH = 3;

/** A string that could be a symbol in someone's source. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function shippedSourceFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Fixtures are sample code the pack reads, not code it ships.
        if (entry.name !== "fixtures" && entry.name !== "__fixtures__") {
          walk(full);
        }
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  };

  if (fs.existsSync(dir)) {
    walk(dir);
  }
  return files;
}

function isModuleSpecifier(node) {
  const parent = node.parent;
  return (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  );
}

/** Property names of an object literal keyed by library identifiers. */
function keysOfIdentifierMap(node) {
  if (!ts.isPropertyAssignment(node)) {
    return [];
  }
  const key = ts.isIdentifier(node.name)
    ? node.name.text
    : ts.isStringLiteral(node.name)
      ? node.name.text
      : null;
  if (key === null || !KEYED_BY_IDENTIFIER.has(key)) {
    return [];
  }
  const literal = mapLiteralBehind(node.initializer, node.getSourceFile());
  if (literal === null) {
    return [];
  }
  return literal.properties
    .map((property) => property.name)
    .filter((name) => name !== undefined)
    .map((name) =>
      ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null,
    )
    .filter((name) => name !== null);
}

/**
 * The object literal a map field's value comes from. Packs write the
 * map inline or declare it as a const and pass the identifier, and the
 * identifier form used to escape the scan entirely.
 */
function mapLiteralBehind(initializer, sourceFile) {
  let value = initializer;
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) {
    value = value.expression;
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value)) {
    return null;
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== value.text ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      let declared = declaration.initializer;
      while (
        ts.isAsExpression(declared) ||
        ts.isSatisfiesExpression(declared)
      ) {
        declared = declared.expression;
      }
      return ts.isObjectLiteralExpression(declared) ? declared : null;
    }
  }
  return null;
}

/**
 * Every identifier a file mentions, with the line it appears on. The
 * pack scan reads both string literals and identifier-keyed map keys;
 * the adapter scan reads literals only, because an adapter's own
 * property names are its code structure, not a claim about a library.
 */
function namesInFile(file, { identifierMapKeys = true } = {}) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Map();
  const record = (name, node) => {
    if (!IDENTIFIER.test(name) || found.has(name)) {
      return;
    }
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.set(name, line + 1);
  };

  const visit = (node) => {
    // A string literal in a type position states the shape of the
    // pack's own options, not a name in anyone's source.
    if (ts.isLiteralTypeNode(node)) {
      return;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !isModuleSpecifier(node)
    ) {
      record(node.text, node);
    }
    if (identifierMapKeys) {
      for (const key of keysOfIdentifierMap(node)) {
        record(key, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function packDirectories() {
  const packs = [];
  for (const family of PACK_FAMILIES) {
    const familyDir = path.join(ROOT, "packages", family);
    if (!fs.existsSync(familyDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(familyDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        packs.push({
          name: `${family}/${entry.name}`,
          dir: path.join(familyDir, entry.name),
        });
      }
    }
  }
  return packs;
}

const shared = new Set(Object.keys(readJson(SHARED_VOCABULARY_FILE)));
// The shared file is the one place a name could be parked to escape a
// pack's own declaration, so an entry no pack uses is reported too.
const sharedUnused = new Set(shared);
const problems = [];

for (const pack of packDirectories()) {
  const vocabularyFile = path.join(pack.dir, VOCABULARY_BASENAME);
  const declared = fs.existsSync(vocabularyFile)
    ? readJson(vocabularyFile)
    : null;

  const named = new Map();
  for (const file of shippedSourceFiles(path.join(pack.dir, "src"))) {
    for (const [name, line] of namesInFile(file)) {
      if (shared.has(name)) {
        sharedUnused.delete(name);
        continue;
      }
      if (named.has(name)) {
        continue;
      }
      named.set(name, `${path.relative(ROOT, file)}:${line}`);
    }
  }

  if (named.size === 0) {
    continue;
  }

  if (declared === null) {
    problems.push(
      `${pack.name} names ${named.size} identifier(s) and has no ${VOCABULARY_BASENAME}.\n` +
        "  Declare each one, with where in the library it comes from:\n" +
        [...named].map(([name, where]) => `    ${name}  (${where})`).join("\n"),
    );
    continue;
  }

  for (const [name, where] of named) {
    const note = declared[name];
    if (note === undefined) {
      problems.push(
        `${pack.name}: ${where} names \`${name}\`, which ${VOCABULARY_BASENAME} does not declare.\n` +
          "  Add it with the library symbol it comes from, or take a name this project chose\n" +
          "  out of the shipped default and let a project supply it through pack config.",
      );
      continue;
    }
    if (typeof note !== "string" || note.trim() === "") {
      problems.push(
        `${pack.name}: \`${name}\` is declared with no note. Say where in the library it comes from.`,
      );
    }
  }

  for (const name of Object.keys(declared)) {
    // A shared-vocabulary name never lands in `named` (the scan skips
    // it), but a pack whose library also defines that name may still
    // declare it, with its own note saying where the library uses it.
    if (!named.has(name) && !shared.has(name)) {
      problems.push(
        `${pack.name}: ${VOCABULARY_BASENAME} declares \`${name}\`, which the pack no longer names. Drop it.`,
      );
    }
  }
}

for (const name of sharedUnused) {
  problems.push(
    `${path.relative(ROOT, SHARED_VOCABULARY_FILE)} declares \`${name}\`, which no pack names. Drop it.`,
  );
}

/** Language adapter packages under packages/adapter, keyed by npm package name so a pack's dependency list can select one. */
function adaptersByPackageName() {
  const adapterFamilyDir = path.join(ROOT, "packages", "adapter");
  const adapters = new Map();
  for (const entry of fs.readdirSync(adapterFamilyDir, {
    withFileTypes: true,
  })) {
    const dir = path.join(adapterFamilyDir, entry.name);
    const packageFile = path.join(dir, "package.json");
    if (!entry.isDirectory() || !fs.existsSync(packageFile)) {
      continue;
    }

    adapters.set(readJson(packageFile).name, {
      name: `adapter/${entry.name}`,
      dir,
    });
  }
  return adapters;
}

/**
 * The library vocabulary each adapter must not name, gathered from the
 * framework packs that declare a dependency on that adapter. Entries
 * noted "suss:" are suss's own tags and convention names, spelled on
 * both sides by design; shared-vocabulary names are suss's own too.
 */
function libraryNamesByAdapter(adapters) {
  const byAdapter = new Map();
  for (const pack of packDirectories()) {
    const packDir = pack.dir;
    const vocabularyFile = path.join(packDir, VOCABULARY_BASENAME);
    const packageFile = path.join(packDir, "package.json");
    if (!fs.existsSync(vocabularyFile) || !fs.existsSync(packageFile)) {
      continue;
    }

    // devDependencies count too: most TypeScript packs hold the
    // adapter as a devDependency (their pattern types come from
    // @suss/extractor), and a pack that only tests against an adapter
    // still drives it.
    const manifest = readJson(packageFile);
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    const driven = Object.keys(dependencies).filter((name) =>
      adapters.has(name),
    );
    if (driven.length === 0) {
      continue;
    }

    for (const [name, note] of Object.entries(readJson(vocabularyFile))) {
      if (
        (typeof note === "string" && note.startsWith("suss:")) ||
        shared.has(name) ||
        name.length < ADAPTER_SCAN_MIN_LENGTH
      ) {
        continue;
      }
      for (const adapterPackage of driven) {
        const names = byAdapter.get(adapterPackage) ?? new Map();
        byAdapter.set(adapterPackage, names);
        names.set(name, pack.name);
      }
    }
  }
  return byAdapter;
}

const adapters = adaptersByPackageName();
const libraryNames = libraryNamesByAdapter(adapters);
for (const [adapterPackage, names] of libraryNames) {
  const adapter = adapters.get(adapterPackage);
  for (const file of shippedSourceFiles(path.join(adapter.dir, "src"))) {
    for (const [name, line] of namesInFile(file, {
      identifierMapKeys: false,
    })) {
      const packName = names.get(name);
      if (packName === undefined) {
        continue;
      }
      problems.push(
        `${adapter.name}: ${path.relative(ROOT, file)}:${line} names \`${name}\`, which ${packName}'s ${VOCABULARY_BASENAME} declares as its library's own.\n` +
          "  Library vocabulary reaches an adapter through a typed pack field, never a literal in adapter source.",
      );
    }
  }
}

if (problems.length === 0) {
  process.stdout.write(
    "Every identifier a pack names is declared in its vocabulary, and no adapter names a pack library's own.\n",
  );
  process.exit(0);
}

for (const problem of problems) {
  process.stderr.write(`${problem}\n\n`);
}
process.stderr.write(
  `${problems.length} vocabulary ${problems.length === 1 ? "problem" : "problems"}. See docs/internal/style.md.\n`,
);
process.exit(1);
