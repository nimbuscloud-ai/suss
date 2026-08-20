#!/usr/bin/env node
/**
 * checkMetadataWiring.mjs: every metadata field needs somebody on both
 * ends of it.
 *
 * A namespace in packages/behavioral-ir/src/metadata.ts is a claim two
 * parties share, and the two sides get built weeks apart. Each ships
 * with a test asserting its own half, and neither test can fail when
 * the other half never arrives. Four features shipped that way (#464).
 * So: take the fields a schema declares, find who writes each one and
 * who reads it back, and fail when a field has only one side. A test
 * does not count as a reader, since a test on the writing side is what
 * http.statusRange already had. Usage: `npm run check:metadata-wiring`,
 * with --verbose for the whole table.
 */

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");

const METADATA_FILE = path.join(ROOT, "packages/behavioral-ir/src/metadata.ts");

/**
 * Packages whose reads count. A checker pass, an `inspect` renderer and
 * an `ask` answer are all consumers. A contract reader reading back
 * what its own package wrote is not, which is why the producing
 * families are absent.
 */
const READER_PACKAGES = ["checker", "checker-intent", "cli"];

/**
 * Fields with one end legitimately missing, and what would fill the
 * gap. Keyed the way a finding spells them, `namespace.field`, with the
 * issue tracking the other half. An entry here is a decision somebody
 * wrote down; a field left without a side is not.
 *
 * Every entry is something this gate found on the day it landed, so
 * the list is the backlog it produced rather than a set of permanent
 * exceptions. Each goes away when its issue does.
 */
const EXEMPT = new Map([
  [
    "messageBus.subject",
    "The subject a rule routes into the drained queue. Pairing keys on the queue, so nothing compares the subject a producer publishes against the one a consumer drains. #464.",
  ],
  [
    "messageBus.detailType",
    "The one DetailType a rule's EventPattern reduces to. The orphan pass pairs on the bus and the rule, and never on this. #464.",
  ],
  [
    "messageBus.events",
    "The S3 event types a bucket notification matches. A producer writing an object no notification matches is the finding this feeds, and that finding does not exist. #464.",
  ],
  [
    "messageBus.topic",
    "The SNS topic an S3 TopicConfiguration notifies. Nothing walks the bucket-to-topic hop yet. #464.",
  ],
  [
    "messageBus.eventName",
    "The SAM event name a subscription was declared under, for a finding that could point at the declaration. No finding does. #464.",
  ],
  [
    "messageBus.deliveredThrough",
    "Marks an SNS subscription that delivers through a queue rather than invoking the function directly. The pairing treats both paths the same way. #464.",
  ],
  [
    "messageBus.fifoQueue",
    "Whether a declared queue is FIFO. Nothing checks ordering. #464.",
  ],
  [
    "messageBus.fifoTopic",
    "Whether a declared topic is FIFO. Same as fifoQueue. #464.",
  ],
  [
    "messageBus.physicalName",
    "The physical QueueName, TopicName or BucketName a template sets, for grounding a name a runtime supplies against the resource that declares it. The storage grounding pass does this through env vars instead. #464.",
  ],
  [
    "runtimeContract.runtime",
    "The language runtime a manifest declares, verbatim. Nothing compares it against the code that ships into the unit. #464.",
  ],
  [
    "routing.unresolvedRouter",
    "Why a router reference did not resolve. The flow rules drop the edge and never report the reason. #464.",
  ],
  [
    "graphql.rootType",
    "Query, Mutation or Subscription for a resolver. Pairing keys on the boundary binding, which already says which. #464.",
  ],
  [
    "graphql.fieldName",
    "The field a resolver serves. Same as rootType: the binding already says. #464.",
  ],
  [
    "graphql.unresolvedDocument",
    "Why an operation's document could not be assembled. unresolvedFragments has its unchecked-selection finding now; nothing reports the assembly failure itself yet. #464.",
  ],
  [
    "http.implementingHandler",
    "The API Gateway readers point a declared route at the code that implements it, for the correlation pass its comment describes. Nothing correlates them. #464.",
  ],
  [
    "libraryEnvReads.module",
    "Which library a marker summary speaks for. The pairing matches on prefixes and names and never asks which library declared them, so a finding cannot say. #464.",
  ],
  [
    "storageContract.indexes",
    "The indexes a schema declares. Storage pairing compares fields and keys; an access that scans without an index is a finding nobody has written. #464.",
  ],
  [
    "metricContract.accumulates",
    "What one measurement covers, written by terraform-gcp. checkMetric compares `values` only, so a GAUGE compared as a DELTA goes unchecked. #464.",
  ],
  [
    "component.storybook.provenance",
    "Whether a story's args are an independent statement about the component. The story agreement check treats every story alike. #464.",
  ],
]);

// ---------------------------------------------------------------------------
// What the schemas declare
// ---------------------------------------------------------------------------

function parseFile(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function unwrap(node) {
  let current = node;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (node.name === undefined) {
    return null;
  }

  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
    return node.name.text;
  }

  return null;
}

/**
 * The fields a `z.object({ ... })` declares, or null when the
 * schema declares no fields of its own. A fieldless namespace is gated
 * whole: something writes it, something reads it.
 */
function schemaFields(initializer) {
  const value = unwrap(initializer);
  const isObjectSchema =
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === "z" &&
    value.expression.name.text === "object";
  if (!isObjectSchema) {
    return null;
  }

  const shape = unwrap(value.arguments[0]);
  if (shape === undefined || !ts.isObjectLiteralExpression(shape)) {
    return null;
  }

  return shape.properties.map(propertyName).filter((name) => name !== null);
}

/**
 * The path into the metadata bag an expression reaches, as the
 * segments after `metadata`. Locals are followed, since the storybook
 * reader reaches its namespace through one.
 */
function metadataPath(node, locals) {
  const value = unwrap(node);
  if (value === undefined) {
    return null;
  }

  if (ts.isIdentifier(value)) {
    const local = locals.get(value.text);
    return local === undefined ? null : metadataPath(local, locals);
  }

  if (!ts.isPropertyAccessExpression(value)) {
    return null;
  }

  if (value.name.text === "metadata") {
    return [];
  }

  const prefix = metadataPath(value.expression, locals);
  return prefix === null ? null : [...prefix, value.name.text];
}

/** Every `const x = ...` in a function body, by name. */
function localsOf(body) {
  const locals = new Map();
  if (body === undefined) {
    return locals;
  }

  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        locals.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return locals;
}

function findFirst(node, predicate) {
  let found = null;
  const visit = (current) => {
    if (found !== null) {
      return;
    }

    if (predicate(current)) {
      found = current;
      return;
    }

    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** The `readNamespace(Schema, expr)` or `Schema.safeParse(expr)` call a reader ends at. */
function namespaceReadIn(body) {
  const call = findFirst(
    body,
    (node) =>
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === "readNamespace" &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0])) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "safeParse" &&
          ts.isIdentifier(node.expression.expression))),
  );
  if (call === null) {
    return null;
  }

  if (ts.isIdentifier(call.expression)) {
    return { schema: call.arguments[0].text, raw: call.arguments[1] };
  }

  return { schema: call.expression.expression.text, raw: call.arguments[0] };
}

/** The namespace key a `with*Metadata` helper stamps, from the property it sets. */
function namespaceWriteIn(body) {
  const assignment = findFirst(
    body,
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.initializer.getText().includes(".strict().parse("),
  );
  return assignment === null ? null : propertyName(assignment);
}

/**
 * Every namespace the IR declares: its path into the metadata bag, the
 * fields its schema declares, the exported type a writer annotates a
 * value with, and the helpers around it. Read out of metadata.ts, so a
 * namespace added there is gated the day it lands.
 */
function readInventory() {
  const source = parseFile(METADATA_FILE);
  const fieldsBySchema = new Map();
  const typeBySchema = new Map();
  const readers = [];
  const writers = new Map();

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          fieldsBySchema.set(
            declaration.name.text,
            schemaFields(declaration.initializer),
          );
        }
      }
      continue;
    }

    // The exported type is the only link from an annotation on a
    // writer's value back to the schema that declares the fields.
    if (ts.isTypeAliasDeclaration(statement)) {
      const inferred = /z\.infer<\s*typeof\s+(\w+)\s*>/.exec(
        statement.type.getText(),
      );
      if (inferred !== null) {
        typeBySchema.set(inferred[1], statement.name.text);
      }
      continue;
    }

    if (
      !ts.isFunctionDeclaration(statement) ||
      statement.name === undefined ||
      statement.body === undefined
    ) {
      continue;
    }

    const name = statement.name.text;

    if (name.startsWith("read")) {
      const read = namespaceReadIn(statement.body);
      const keyPath =
        read === null ? null : metadataPath(read.raw, localsOf(statement.body));
      if (keyPath !== null && keyPath.length > 0) {
        readers.push({ reader: name, schema: read.schema, keyPath });
      }
      continue;
    }

    if (name.startsWith("with")) {
      const key = namespaceWriteIn(statement.body);
      if (key !== null) {
        writers.set(key, name);
      }
    }
  }

  return readers.map(({ reader, schema, keyPath }) => ({
    key: keyPath.join("."),
    keyPath,
    fields: fieldsBySchema.get(schema) ?? null,
    type: typeBySchema.get(schema) ?? null,
    reader,
    writer: writers.get(keyPath.at(-1)) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The source both sides live in
// ---------------------------------------------------------------------------

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "fixtures",
  "__fixtures__",
]);

/** Shipped source under a directory: no tests, no fixtures, no build output. */
function shippedSourceFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
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

/** Every package's src directory, at both nesting depths the workspace uses. */
function packageSourceDirectories() {
  const dirs = [];
  const packagesDir = path.join(ROOT, "packages");
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const familyDir = path.join(packagesDir, entry.name);
    if (fs.existsSync(path.join(familyDir, "src"))) {
      dirs.push({ pkg: entry.name, dir: path.join(familyDir, "src") });
      continue;
    }

    for (const member of fs.readdirSync(familyDir, { withFileTypes: true })) {
      const memberSrc = path.join(familyDir, member.name, "src");
      if (member.isDirectory() && fs.existsSync(memberSrc)) {
        dirs.push({ pkg: entry.name, dir: memberSrc });
      }
    }
  }
  return dirs;
}

function where(file, node) {
  const { line } = node
    .getSourceFile()
    .getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(ROOT, file)}:${line + 1}`;
}

/** The namespace an annotation refers to, in its plain, optional and ReturnType spellings. */
function annotatedNamespace(typeNode, byType) {
  if (typeNode === undefined) {
    return null;
  }

  const text = typeNode.getText();
  for (const [name, namespace] of byType) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      return namespace;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Who writes a field
// ---------------------------------------------------------------------------

const NOTHING = { keys: [], opaque: false };

function combine(parts) {
  return {
    keys: parts.flatMap((part) => part.keys),
    opaque: parts.some((part) => part.opaque),
  };
}

/**
 * The keys an expression puts on a namespace. Spreads, conditional
 * halves and same-file consts are followed, since writers build a
 * namespace out of all three. Anything else comes back opaque, which
 * counts as writing the namespace without saying which fields.
 */
function writtenKeys(node, context, seen = new Set()) {
  const value = unwrap(node);
  if (value === undefined || value.kind === ts.SyntaxKind.NullKeyword) {
    return NOTHING;
  }

  if (ts.isObjectLiteralExpression(value)) {
    const parts = [];
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        parts.push(writtenKeys(property.expression, context, seen));
        continue;
      }

      const name = propertyName(property);
      if (name !== null) {
        parts.push({ keys: [name], opaque: false });
      }
    }
    return combine(parts);
  }

  if (ts.isConditionalExpression(value)) {
    return combine([
      writtenKeys(value.whenTrue, context, seen),
      writtenKeys(value.whenFalse, context, seen),
    ]);
  }

  if (ts.isBinaryExpression(value)) {
    return combine([
      writtenKeys(value.left, context, seen),
      writtenKeys(value.right, context, seen),
    ]);
  }

  // Reading the namespace back to add one field to it puts nothing new
  // on it, and a call whose returns are recorded where they are written
  // would be counted twice.
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    context.recorded.has(value.expression.text)
  ) {
    return NOTHING;
  }

  if (ts.isIdentifier(value)) {
    if (value.text === "undefined") {
      return NOTHING;
    }

    const declared = seen.has(value.text)
      ? undefined
      : context.consts.get(value.text);
    if (declared !== undefined) {
      return writtenKeys(declared, context, new Set([...seen, value.text]));
    }
  }

  return { keys: [], opaque: true };
}

/** Every `const x = ...` in a file, by name, for a namespace built one statement earlier. */
function constantsOf(source) {
  const consts = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      consts.set(node.name.text, node.initializer);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return consts;
}

/** Which of the file's functions are declared to return a namespace value. */
function returningFunctionNames(source, namespaceForType) {
  const names = new Set();
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      namespaceForType(node.type) !== null
    ) {
      names.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Variables and parameters annotated with a namespace type, by name. */
function annotatedNamesOf(source, namespaceForType) {
  const names = new Map();
  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const namespace = namespaceForType(node.type);
      if (namespace !== null) {
        names.set(node.name.text, namespace);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Which parameter of each named function takes a namespace, by function name. */
function parameterNamespacesOf(source, namespaceForType) {
  const byFunction = new Map();
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      byFunction.set(
        node.name.text,
        node.parameters.map((parameter) => namespaceForType(parameter.type)),
      );
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return byFunction;
}

/**
 * Where each namespace's fields are written. A writer reaches a
 * namespace four ways: through its `with*Metadata` helper, as a raw
 * key inside a `metadata` bag, through a value annotated with the
 * namespace type, and as an argument to a same-file function whose
 * parameter is.
 */
function scanWriters(file, source, namespaces, sink) {
  const byHelper = new Map(
    namespaces
      .filter((namespace) => namespace.writer !== null)
      .map((namespace) => [namespace.writer, namespace]),
  );
  const byType = new Map(
    namespaces
      .filter((namespace) => namespace.type !== null)
      .map((namespace) => [namespace.type, namespace]),
  );
  const byPath = new Map(
    namespaces.map((namespace) => [namespace.key, namespace]),
  );
  const namespaceForType = (typeNode) => annotatedNamespace(typeNode, byType);
  const byFunction = parameterNamespacesOf(source, namespaceForType);
  const context = {
    consts: constantsOf(source),
    recorded: new Set([
      ...namespaces.map((namespace) => namespace.reader),
      ...returningFunctionNames(source, namespaceForType),
    ]),
  };
  const annotatedNames = annotatedNamesOf(source, namespaceForType);

  const record = (namespace, node) => {
    if (node === undefined) {
      return;
    }

    const { keys, opaque } = writtenKeys(node, context);
    sink(namespace, keys, opaque, where(file, node));
  };

  // A bag is the `metadata` object itself. Its namespace-named keys
  // are the raw writes, and a namespace two levels down is reached by
  // descending one key at a time.
  const recordBag = (node, prefix) => {
    const value = node === undefined ? undefined : unwrap(node);
    if (value === undefined || !ts.isObjectLiteralExpression(value)) {
      return;
    }

    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        recordBag(property.expression, prefix);
        continue;
      }

      const name = propertyName(property);
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : null;
      if (name === null || value === null) {
        continue;
      }

      const reached = [...prefix, name].join(".");
      const namespace = byPath.get(reached);
      if (namespace !== undefined) {
        record(namespace, value);
        continue;
      }

      if ([...byPath.keys()].some((key) => key.startsWith(`${reached}.`))) {
        recordBag(value, [...prefix, name]);
      }
    }
  };

  const walk = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = byHelper.get(node.expression.text);
      if (helper !== undefined) {
        record(helper, node.arguments[1]);
        recordBag(node.arguments[0], []);
      }

      const parameters = byFunction.get(node.expression.text) ?? [];
      for (const [index, namespace] of parameters.entries()) {
        if (namespace !== null && node.arguments[index] !== undefined) {
          record(namespace, node.arguments[index]);
        }
      }
    }

    if (ts.isPropertyAssignment(node) && propertyName(node) === "metadata") {
      recordBag(node.initializer, []);
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      if (node.left.name.text === "metadata") {
        recordBag(node.right, []);
      }

      // A writer that declares an empty namespace value and fills it
      // in field by field writes each one here, not at the literal.
      const target = ts.isIdentifier(node.left.expression)
        ? annotatedNames.get(node.left.expression.text)
        : undefined;
      if (target !== undefined) {
        sink(target, [node.left.name.text], false, where(file, node));
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const annotated = namespaceForType(node.type);
      if (annotated !== null) {
        record(annotated, node.initializer);
      }

      if (ts.isIdentifier(node.name) && node.name.text === "metadata") {
        recordBag(node.initializer, []);
      }
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body !== undefined &&
      namespaceForType(node.type) !== null
    ) {
      for (const statement of node.body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression) {
          record(namespaceForType(node.type), statement.expression);
        }
      }
    }

    ts.forEachChild(node, walk);
  };
  walk(source);
}

// ---------------------------------------------------------------------------
// Who reads a field
// ---------------------------------------------------------------------------

/** The namespace behind a `ReturnType<typeof readMessageBusMetadata>` annotation. */
function readerReturnNamespace(typeNode, byReader) {
  if (typeNode === undefined) {
    return null;
  }

  const match = /ReturnType<\s*typeof\s+(\w+)\s*>/.exec(typeNode.getText());
  return match === null ? null : (byReader.get(match[1]) ?? null);
}

/**
 * What a file calls a namespace value: what the IR's reader returns,
 * what a local binds it to, what a parameter is annotated with, and
 * what a helper elsewhere in the reading packages returns.
 */
function readerContext(source, namespaces, returningFunctions) {
  const byReader = new Map(
    namespaces.map((namespace) => [namespace.reader, namespace]),
  );
  const byType = new Map(
    namespaces
      .filter((namespace) => namespace.type !== null)
      .map((namespace) => [namespace.type, namespace]),
  );
  const namespaceForType = (typeNode) =>
    annotatedNamespace(typeNode, byType) ??
    readerReturnNamespace(typeNode, byReader);
  const names = new Map();

  const namespaceOf = (node) => {
    const value = node === undefined ? undefined : unwrap(node);
    if (value === undefined) {
      return null;
    }

    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
      return (
        byReader.get(value.expression.text) ??
        returningFunctions.get(value.expression.text) ??
        null
      );
    }

    if (ts.isIdentifier(value)) {
      return names.get(value.text) ?? null;
    }

    if (ts.isBinaryExpression(value)) {
      return namespaceOf(value.left) ?? namespaceOf(value.right);
    }

    if (ts.isConditionalExpression(value)) {
      return namespaceOf(value.whenTrue) ?? namespaceOf(value.whenFalse);
    }

    return null;
  };

  // Names are bound in one pass first: a read several statements below
  // the const that named the value still has to resolve.
  const bind = (node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const annotated = namespaceForType(node.type);
      if (annotated !== null) {
        names.set(node.name.text, annotated);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const namespace = namespaceOf(node.initializer);
      if (namespace !== null) {
        names.set(node.name.text, namespace);
      }
    }

    ts.forEachChild(node, bind);
  };
  bind(source);

  return {
    namespaceOf,
    namespaceForType,
    byFunction: parameterNamespacesOf(source, namespaceForType),
  };
}

function returnedNamespace(body, namespaceOf) {
  let namespace = null;
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      namespace = namespace ?? namespaceOf(node.expression);
    }

    ts.forEachChild(node, visit);
  };
  visit(body);
  return namespace;
}

/**
 * Functions in the reading packages that hand a namespace value on,
 * keyed by name. `contractOf(summary).fields` is a field-level read
 * through one of these, and without them the namespace would look like
 * it escaped into nothing.
 */
function namespaceReturningFunctions(files, namespaces, known) {
  const found = new Map(known);
  for (const { source } of files) {
    const context = readerContext(source, namespaces, found);
    const visit = (node) => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.body !== undefined
      ) {
        const namespace =
          context.namespaceForType(node.type) ??
          returnedNamespace(node.body, context.namespaceOf);
        if (namespace !== null) {
          found.set(node.name.text, namespace);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * Whether some function in the file takes this namespace at this
 * argument position. A dispatch table's entries are reached through
 * the table, so the call itself says nothing about which one runs, and
 * the entries read their fields in their own bodies either way.
 */
function takesNamespaceAt(byFunction, index, namespace) {
  if (namespace === null) {
    return false;
  }

  return [...byFunction.values()].some(
    (parameters) => parameters[index]?.key === namespace.key,
  );
}

/**
 * Where each namespace's fields are read. A property access on a
 * namespace value reads that field; handing the whole value to
 * something this scan cannot follow reads all of them, recorded as
 * such so the gate never calls a field unread on the strength of what
 * it could not see.
 */
function scanReaders(file, source, namespaces, returningFunctions, sink) {
  const { namespaceOf, byFunction } = readerContext(
    source,
    namespaces,
    returningFunctions,
  );

  const walk = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const namespace = namespaceOf(node.expression);
      if (namespace !== null) {
        sink(namespace, [node.name.text], false, where(file, node));
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      const namespace = namespaceOf(node.expression);
      if (namespace !== null) {
        sink(
          namespace,
          [node.argumentExpression.text],
          false,
          where(file, node),
        );
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      const namespace = namespaceOf(node.initializer);
      if (namespace !== null) {
        const bound = node.name.elements
          .map((element) => element.propertyName ?? element.name)
          .map((name) => (ts.isIdentifier(name) ? name.text : null))
          .filter((name) => name !== null);
        sink(namespace, bound, false, where(file, node));
      }
    }

    if (ts.isSpreadAssignment(node)) {
      const namespace = namespaceOf(node.expression);
      if (namespace !== null) {
        sink(namespace, [], true, where(file, node));
      }
    }

    if (ts.isCallExpression(node)) {
      const parameters = ts.isIdentifier(node.expression)
        ? (byFunction.get(node.expression.text) ?? [])
        : [];
      for (const [index, argument] of node.arguments.entries()) {
        const namespace = namespaceOf(argument);
        // A callee whose parameter takes the namespace type reads it in
        // its own body; anything else takes the value out of sight.
        const followed =
          (parameters[index] ?? null) !== null ||
          takesNamespaceAt(byFunction, index, namespace);
        if (namespace !== null && !followed) {
          sink(namespace, [], true, where(file, argument));
        }
      }
    }

    ts.forEachChild(node, walk);
  };
  walk(source);
}

// ---------------------------------------------------------------------------
// The two sides, compared
// ---------------------------------------------------------------------------

const namespaces = readInventory();
const sides = new Map(
  namespaces.map((namespace) => [
    namespace.key,
    {
      namespace,
      writes: new Map(),
      reads: new Map(),
      opaqueWrites: [],
      opaqueReads: [],
      undeclared: new Map(),
    },
  ]),
);

function recordSide(namespace, keys, opaque, site, direction) {
  const record = sides.get(namespace.key);
  if (opaque) {
    record[direction === "write" ? "opaqueWrites" : "opaqueReads"].push(site);
  }

  if (namespace.fields === null) {
    return;
  }

  for (const key of keys) {
    if (!namespace.fields.includes(key)) {
      if (direction === "write") {
        const sites = record.undeclared.get(key) ?? [];
        record.undeclared.set(key, [...sites, site]);
      }
      continue;
    }

    const bucket = direction === "write" ? record.writes : record.reads;
    bucket.set(key, [...(bucket.get(key) ?? []), site]);
  }
}

const sources = new Map();
function sourceOf(file) {
  const cached = sources.get(file);
  if (cached !== undefined) {
    return cached;
  }

  const parsed = parseFile(file);
  sources.set(file, parsed);
  return parsed;
}

const sourceDirectories = packageSourceDirectories();

for (const { pkg, dir } of sourceDirectories) {
  // behavioral-ir declares the namespaces, so its own helpers are
  // neither side of the claim, and a checker pass stamping a field on
  // a summary it derived and then reading it back is a closed loop.
  if (pkg === "behavioral-ir" || READER_PACKAGES.includes(pkg)) {
    continue;
  }

  for (const file of shippedSourceFiles(dir)) {
    scanWriters(file, sourceOf(file), namespaces, (namespace, ...rest) =>
      recordSide(namespace, ...rest, "write"),
    );
  }
}

const readerFiles = sourceDirectories
  .filter(({ pkg }) => READER_PACKAGES.includes(pkg))
  .flatMap(({ dir }) => shippedSourceFiles(dir))
  .map((file) => ({ file, source: sourceOf(file) }));

// Twice around: a helper that returns a namespace has to be known
// before the file calling it is read, whatever order the files come in.
let returningFunctions = namespaceReturningFunctions(
  readerFiles,
  namespaces,
  new Map(),
);
returningFunctions = namespaceReturningFunctions(
  readerFiles,
  namespaces,
  returningFunctions,
);

for (const { file, source } of readerFiles) {
  scanReaders(
    file,
    source,
    namespaces,
    returningFunctions,
    (namespace, ...rest) => recordSide(namespace, ...rest, "read"),
  );
}

const problems = [];
const excused = new Set();

/** Where a field was touched, saying so when the whole namespace moved at once. */
function site(byField, wholeNamespace) {
  if (byField !== undefined) {
    return byField[0];
  }

  return `${wholeNamespace[0]} (the whole namespace at once)`;
}

function report(key, message) {
  if (EXEMPT.has(key)) {
    excused.add(key);
    return;
  }

  problems.push(`${key}: ${message}`);
}

for (const record of sides.values()) {
  const { namespace, writes, reads, opaqueWrites, opaqueReads } = record;
  const wroteWhole = opaqueWrites.length > 0;
  const readWhole = opaqueReads.length > 0;

  for (const [key, sites] of record.undeclared) {
    report(
      `${namespace.key}.${key}`,
      `${sites[0]} writes it, and the schema does not declare it, so every read drops it.`,
    );
  }

  for (const field of namespace.fields ?? [namespace.key]) {
    const label =
      namespace.fields === null ? namespace.key : `${namespace.key}.${field}`;
    const written = writes.has(field) || wroteWhole;
    const read = reads.has(field) || readWhole;

    if (written && !read) {
      report(
        label,
        `${site(writes.get(field), opaqueWrites)} writes it, and nothing in ${READER_PACKAGES.join(", ")} reads it back.`,
      );
      continue;
    }

    if (read && !written) {
      report(
        label,
        `${site(reads.get(field), opaqueReads)} reads it, and no package outside ${READER_PACKAGES.join(", ")} writes it.`,
      );
      continue;
    }

    if (!written && !read) {
      report(label, "nothing writes it and nothing reads it.");
    }
  }
}

for (const key of EXEMPT.keys()) {
  if (!excused.has(key)) {
    problems.push(
      `${key} is exempt in scripts/checkMetadataWiring.mjs but has both sides now, or no longer exists. Drop the EXEMPT entry.`,
    );
  }
}

if (process.argv.includes("--verbose")) {
  for (const record of sides.values()) {
    const { namespace, writes, reads } = record;
    process.stdout.write(`${namespace.key} (${namespace.reader})\n`);
    for (const field of namespace.fields ?? [namespace.key]) {
      process.stdout.write(
        `  ${field}: ${writes.get(field)?.length ?? 0} writer(s), ${reads.get(field)?.length ?? 0} reader(s)\n`,
      );
    }

    for (const site of record.opaqueWrites) {
      process.stdout.write(`  whole namespace written at ${site}\n`);
    }

    for (const site of record.opaqueReads) {
      process.stdout.write(`  whole namespace read at ${site}\n`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `\n✗ ${problems.length} metadata field${problems.length === 1 ? "" : "s"} with one side missing:\n`,
  );
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.stderr.write(
    "\nWire the missing side, or add the field to EXEMPT in scripts/checkMetadataWiring.mjs with the reason it waits and the issue tracking it.\n",
  );
  process.exit(1);
}

const gated = namespaces.reduce(
  (total, namespace) => total + (namespace.fields?.length ?? 1),
  0,
);
process.stdout.write(
  `✓ ${gated - EXEMPT.size} metadata fields across ${namespaces.length} namespaces have a writer and a reader, ${EXEMPT.size} exempt by name.\n`,
);
