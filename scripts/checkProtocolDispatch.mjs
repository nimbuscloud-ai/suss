#!/usr/bin/env node
// checkProtocolDispatch.mjs: generic code does not branch on protocol
// names.
//
// A protocol's behavior lives in its module under
// packages/ir-core/src/semantics/, in the packs that write it, and in
// its own checker module. Everything else dispatches through the
// registry (boundaryKey, pairingKey, semanticsAgree, displayLabel,
// ruleBoundary). A `semantics.name === "rest"` in a generic file is
// how the tool ends up spelling one route two ways, or eating a
// message-bus suppression rule: two shipped bugs, #145 and #146, had
// exactly this shape.
//
// Packs and per-protocol checker modules narrow to their own protocol
// legitimately, so those directories are allowed outright. The
// remaining generic files carry an explicit count that may only go
// down. Fixing a listed site means lowering its number here in the
// same change; adding a new branch anywhere fails the build. When a
// generic file needs protocol behavior, add a member to the semantics
// definition instead, the way displayLabel and ruleBoundary were
// added.
//
// Run it with `npm run check:dispatch`.

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");

const PROTOCOLS = [
  "rest",
  "message-bus",
  "graphql-resolver",
  "graphql-operation",
  "runtime-config",
  "storage",
  "function-call",
  "metric",
  "unit-invocation",
];

const PROTOCOL_SET = new Set(PROTOCOLS);

/**
 * Protocol-name branches in one file, found by walking the AST rather
 * than matching lines. A comparison split across lines, a switch over
 * `semantics.name`, and a destructured alias all count; a matching
 * substring in a comment never does (#164).
 */
function protocolBranchCount(abs) {
  const source = ts.createSourceFile(
    abs,
    fs.readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let n = 0;

  const isProtocolLiteral = (node) =>
    ts.isStringLiteral(node) && PROTOCOL_SET.has(node.text);
  const couldBeNameAccess = (node) =>
    (ts.isPropertyAccessExpression(node) && node.name.text === "name") ||
    ts.isIdentifier(node);

  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const sides = [node.left, node.right];
      if (
        sides.some(isProtocolLiteral) &&
        sides.some((side) => couldBeNameAccess(side))
      ) {
        n += 1;
      }
    }

    if (ts.isSwitchStatement(node) && couldBeNameAccess(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && isProtocolLiteral(clause.expression)) {
          n += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return n;
}

/** Directories whose files own the protocols they name. */
const OWNING_DIRS = [
  "packages/ir-core/src/semantics/",
  "packages/contract/",
  "packages/terraform/",
  "packages/framework/",
  "packages/client/",
  "packages/runtime/",
  "packages/manifest/",
  "packages/checker/src/message-bus/",
  "packages/checker/src/metric/",
  "packages/checker/src/runtime-config/",
  "packages/checker/src/storage/",
  "packages/checker/src/story/",
  "packages/checker/src/unit-invocation/",
  "packages/checker/src/pairing/graphqlPairing.ts",
  "packages/checker/src/pairing/semanticBridging.ts",
  "packages/checker/src/contract/",
];

/**
 * Generic files with protocol branches that predate the rule. Counts
 * only go down. Every entry is a place a registry member should
 * eventually replace an if.
 */
const RATCHET = {
  // #147: bindingLabel should become displayLabel dispatch; its labels
  // feed effectsClosure, so the conversion wants its own change.
  "packages/adapter/typescript/src/resolve/boundaryEffects.ts": 6,
  "packages/adapter/typescript/src/adapter.ts": 4,
  "packages/cli/src/check.ts": 2,
  "packages/cli/src/corroborate.ts": 1,
  "packages/cli/src/corroborateCommand.ts": 1,
  "packages/cli/src/inspect.ts": 3, // #147's remaining piece
};

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "coverage"
      ) {
        continue;
      }
      yield* sourceFiles(abs);
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield abs;
    }
  }
}

const counts = new Map();
for (const abs of sourceFiles(path.join(ROOT, "packages"))) {
  const rel = path.relative(ROOT, abs);
  if (OWNING_DIRS.some((d) => rel.startsWith(d))) {
    continue;
  }
  const n = protocolBranchCount(abs);
  if (n > 0) {
    counts.set(rel, n);
  }
}

const problems = [];
for (const [rel, n] of counts) {
  const allowed = RATCHET[rel];
  if (allowed === undefined) {
    problems.push(
      `${rel}: ${n} protocol-name branch${n === 1 ? "" : "es"} in a generic file. Add a member to the semantics definition and dispatch through the registry instead.`,
    );
  } else if (n > allowed) {
    problems.push(
      `${rel}: ${n} protocol-name branches, ratchet allows ${allowed}. New branches go through the registry.`,
    );
  }
}
for (const [rel, allowed] of Object.entries(RATCHET)) {
  const n = counts.get(rel) ?? 0;
  if (n < allowed) {
    problems.push(
      `${rel}: ${n} protocol-name branches, ratchet still says ${allowed}. Lower the entry so the progress sticks.`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(`✗ protocol dispatch:\n  ${problems.join("\n  ")}\n`);
  process.exit(1);
}

process.stdout.write(
  "Generic code branches on no protocol name it is not already ratcheted for.\n",
);
