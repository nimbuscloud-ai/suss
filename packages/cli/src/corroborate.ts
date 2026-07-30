// corroborate.ts — upgrade derivations with observations (experimental).
//
// For each transition of a handler summary: generate inputs that
// satisfy the transition's own extracted conditions (rejection
// sampling with the three-valued interpreter as the oracle — no
// constraint solver), execute the real handler function in a vm with
// a stub response object, and compare the observed status with the
// claimed one. The verdict lands on
// `transition.confidence.corroboration`:
//
//   - observed  — every satisfying run produced the claimed status
//   - refuted   — some satisfying run produced a different status;
//                 the counterexample is attached (an extractor bug or
//                 a genuine surprise — both are product output)
//   - untested  — no satisfying input was found (conditions abstain
//                 or sampling missed), or every run hit a dependency
//                 the harness cannot supply (a bare `ReferenceError`
//                 in the sandbox marks the path as dependency-gated)
//
// Scope (v0): `handler`-kind summaries with rest semantics recognized
// by the express or fastify packs — the response-object protocols the
// vm stub can speak. Everything else is skipped untouched.

import vm from "node:vm";

import { Node, type Project, ts } from "ts-morph";

import {
  type BehavioralSummary,
  evalConditions,
  type Predicate,
  type Transition,
  type ValueRef,
} from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Input synthesis — pools from the summary's own predicates
// ---------------------------------------------------------------------------

interface InputPath {
  root: string;
  path: string[];
}

function refPaths(ref: ValueRef, out: InputPath[]): void {
  if (ref.type === "input") {
    out.push({ root: ref.inputRef, path: [...ref.path] });
    return;
  }
  if (ref.type === "derived") {
    const inner: InputPath[] = [];
    refPaths(ref.from, inner);
    const segment =
      ref.derivation.type === "propertyAccess"
        ? ref.derivation.property
        : ref.derivation.type === "destructured"
          ? ref.derivation.field
          : ref.derivation.type === "indexAccess"
            ? String(ref.derivation.index)
            : null;
    for (const base of inner) {
      out.push(
        segment === null
          ? base
          : { root: base.root, path: [...base.path, segment] },
      );
    }
  }
}

function collectPredicateFacts(
  predicate: Predicate,
  paths: InputPath[],
  literals: Set<string>,
): void {
  const visitRef = (ref: ValueRef): void => {
    refPaths(ref, paths);
    if (ref.type === "literal" && typeof ref.value === "string") {
      literals.add(ref.value);
    }
  };
  if (
    predicate.type === "truthinessCheck" ||
    predicate.type === "nullCheck" ||
    predicate.type === "typeCheck"
  ) {
    visitRef(predicate.subject);
    return;
  }
  if (predicate.type === "propertyExists") {
    const subjectPaths: InputPath[] = [];
    refPaths(predicate.subject, subjectPaths);
    paths.push(...subjectPaths);
    for (const base of subjectPaths) {
      paths.push({ root: base.root, path: [...base.path, predicate.property] });
    }
    return;
  }
  if (predicate.type === "comparison") {
    visitRef(predicate.left);
    visitRef(predicate.right);
    return;
  }
  if (predicate.type === "compound") {
    for (const operand of predicate.operands) {
      collectPredicateFacts(operand, paths, literals);
    }
    return;
  }
  if (predicate.type === "negation") {
    collectPredicateFacts(predicate.operand, paths, literals);
  }
}

/** mulberry32 — deterministic PRNG so corroboration runs reproduce. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCandidate(
  paths: InputPath[],
  pool: string[],
  random: () => number,
): Record<string, unknown> {
  const roots: Record<string, unknown> = {};
  const enter = (
    container: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> => {
    if (typeof container[key] !== "object" || container[key] === null) {
      container[key] = {};
    }
    return container[key] as Record<string, unknown>;
  };
  for (const { root, path } of paths) {
    if (random() < 0.25) {
      continue; // leave this field absent sometimes
    }
    let cursor = enter(roots, root);
    for (let i = 0; i < path.length - 1; i++) {
      cursor = enter(cursor, path[i]);
    }
    if (path.length > 0) {
      cursor[path[path.length - 1]] = pool[Math.floor(random() * pool.length)];
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Observed {
  status: number;
}

type RunResult =
  | { type: "ok"; observed: Observed }
  | { type: "dependency"; message: string }
  | { type: "error"; message: string };

function makeResponder(record: (o: Observed) => void): object {
  let current = 200;
  const res: Record<string, unknown> = {};
  const setStatus = (code: number) => {
    current = code;
    return res;
  };
  const send = () => {
    record({ status: current });
    return res;
  };
  Object.assign(res, {
    status: setStatus,
    code: setStatus,
    json: send,
    send,
    sendStatus: (code: number) => {
      record({ status: code });
      return res;
    },
    redirect: (a: unknown) => {
      record({ status: typeof a === "number" ? a : 302 });
      return res;
    },
  });
  return res;
}

async function executeOnce(
  compiled: string,
  reqValue: unknown,
): Promise<RunResult> {
  const responses: Observed[] = [];
  const moduleRef = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module: moduleRef,
    exports: moduleRef.exports,
    req: reqValue,
    res: makeResponder((o) => {
      responses.push(o);
    }),
  };
  try {
    vm.runInNewContext(
      `${compiled}\nmodule.exports.__result = module.exports.__handler(req, res);`,
      sandbox,
      { timeout: 1000 },
    );
    await Promise.resolve(moduleRef.exports.__result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/is not defined/.test(message)) {
      return { type: "dependency", message };
    }
    return { type: "error", message };
  }
  if (responses.length !== 1) {
    return { type: "error", message: `${responses.length} responses recorded` };
  }
  return { type: "ok", observed: responses[0] };
}

// ---------------------------------------------------------------------------
// Per-summary corroboration
// ---------------------------------------------------------------------------

export interface CorroborateOptions {
  /** Verdict-producing executions to aim for per transition. */
  runs?: number;
  /** Sampling attempts per transition before giving up. */
  attempts?: number;
}

const SUPPORTED_RECOGNITION = new Set(["express", "fastify"]);

function locateFunctionText(
  summary: BehavioralSummary,
  project: Project,
): string | null {
  const file = project
    .getSourceFiles()
    .find((sf) => sf.getFilePath().endsWith(summary.location.file));
  if (file === undefined) {
    return null;
  }
  let text: string | null = null;
  file.forEachDescendant((node, traversal) => {
    if (text !== null) {
      traversal.stop();
      return;
    }
    if (
      (Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        Node.isFunctionDeclaration(node)) &&
      node.getStartLineNumber() === summary.location.range.start &&
      node.getEndLineNumber() === summary.location.range.end
    ) {
      text = node.getText();
    }
  });
  return text;
}

function claimedStatus(transition: Transition): number | null {
  if (
    transition.output.type === "response" &&
    transition.output.statusCode !== null &&
    transition.output.statusCode.type === "literal" &&
    typeof transition.output.statusCode.value === "number"
  ) {
    return transition.output.statusCode.value;
  }
  return null;
}

/**
 * Corroborate one summary in place: stamps
 * `transition.confidence.corroboration` on every response transition
 * with a literal status. Returns true when the summary was in scope.
 */
export async function corroborateSummary(
  summary: BehavioralSummary,
  project: Project,
  options: CorroborateOptions = {},
): Promise<boolean> {
  const runsTarget = options.runs ?? 25;
  const attempts = options.attempts ?? 300;
  const binding = summary.identity.boundaryBinding;
  if (
    summary.kind !== "handler" ||
    binding === null ||
    binding.semantics.name !== "rest" ||
    !SUPPORTED_RECOGNITION.has(binding.recognition)
  ) {
    return false;
  }
  const requestInput = summary.inputs.find(
    (input) => input.type === "parameter" && input.role === "request",
  );
  const requestName =
    requestInput?.type === "parameter" ? requestInput.name : "req";
  const text = locateFunctionText(summary, project);
  if (text === null) {
    return false;
  }
  const compiled = ts.transpileModule(`module.exports.__handler = (${text});`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  for (const transition of summary.transitions) {
    const status = claimedStatus(transition);
    if (status === null) {
      continue;
    }
    const paths: InputPath[] = [];
    const literals = new Set<string>(["", "a"]);
    for (const condition of transition.conditions) {
      collectPredicateFacts(condition, paths, literals);
    }
    const pool = [...literals];
    const random = mulberry32(0x5eed + summary.transitions.indexOf(transition));

    let verdictRuns = 0;
    let dependencyGated = 0;
    let counterexample: unknown = null;
    let satisfiedAny = false;

    for (let i = 0; i < attempts && verdictRuns < runsTarget; i++) {
      const candidate = buildCandidate(paths, pool, random);
      const reqValue = candidate[requestName] ?? {};
      if (
        evalConditions(transition.conditions, { [requestName]: reqValue }) !==
        "true"
      ) {
        continue;
      }
      satisfiedAny = true;
      const run = await executeOnce(compiled, reqValue);
      if (run.type === "dependency") {
        dependencyGated += 1;
        continue;
      }
      if (run.type === "error") {
        continue;
      }
      verdictRuns += 1;
      if (run.observed.status !== status && counterexample === null) {
        counterexample = {
          request: reqValue,
          observedStatus: run.observed.status,
          claimedStatus: status,
        };
      }
    }

    const corroboration =
      counterexample !== null
        ? { outcome: "refuted" as const, runs: verdictRuns, counterexample }
        : verdictRuns > 0
          ? { outcome: "observed" as const, runs: verdictRuns }
          : {
              outcome: "untested" as const,
              runs: 0,
              reason:
                dependencyGated > 0
                  ? "dependency-gated path"
                  : satisfiedAny
                    ? "no run produced a verdict"
                    : "no satisfying input found",
            };
    transition.confidence = {
      ...(transition.confidence ?? {
        source: "inferred_static",
        level: "high",
      }),
      corroboration,
    };
  }
  return true;
}
