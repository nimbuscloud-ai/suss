/**
 * Test cases a runner writes as calls, as vitest does:
 * `describe("orders", () => { it("cancels", () => ...) })`.
 *
 * Every call the file writes is asked whether it is one of the runner's,
 * and each runner call and each mock is walked up to the runner calls
 * around it, through the call it is an argument of or the function it is
 * written in. So a case written in a callback or a loop inside a group is
 * in that group, the way the runner collects it. A case is titled by the
 * runner calls around it, then its own first argument, and runs the first
 * function passed after that. A mock applies to a case when every runner
 * call around the mock is the case or one around it. The recognize
 * DESIGN.md says what the walk reads at each step.
 */

import { matchesTestFileName } from "@suss/extractor";

import { mockRead } from "./testCases.js";

import type {
  CallCases,
  CallOps,
  ModuleOps,
  TestCasesMatch,
  ValueOps,
} from "@suss/extractor";
import type { CaseTitle, FoundCase, FoundMock, MockRead } from "./testCases.js";

/** One call the runner reads as a group or a case. */
interface RunnerCall {
  readonly call: CallOps;
  readonly site: string;
  readonly role: "group" | "case";
  readonly skipped: boolean;
  /** Whether a modifier such as `each` declares one case per row, each titled by its row. */
  readonly perRow: boolean;
}

/** The cases the runner writes as calls in the module, in source order. */
export function callCases(
  match: TestCasesMatch,
  module: ModuleOps,
): FoundCase[] {
  const calls = match.calls;
  if (calls === undefined) {
    return [];
  }
  const spelled = runnerSpellings(calls, module);
  if (spelled.size === 0) {
    return [];
  }
  const runners = new Map<string, RunnerCall>();
  const mockCalls: (KeyedCall & { readonly read: MockRead })[] = [];
  for (const { call, site } of keyedCalls(module)) {
    const runner = runnerCallOf(call, spelled, calls);
    if (runner !== null) {
      runners.set(site, { ...runner, call, site });
      continue;
    }
    // A case written as a call takes no fixture, so no patcher is handed one.
    const read = mockRead(match.mocks ?? [], call, takesNoFixture);
    if (read !== null) {
      mockCalls.push({ call, site, read });
    }
  }
  const around = new RunnersAround(runners);
  const mocks = mockCalls.map((mock) => ({
    mock: { call: mock.call, read: mock.read } satisfies FoundMock,
    around: around.of(mock).map((one) => one.site),
  }));
  return [...runners.values()].flatMap((runner) => {
    if (runner.role !== "case") {
      return [];
    }
    const groups = around.of(runner);
    const inScope = new Set([...groups.map((one) => one.site), runner.site]);
    return [
      {
        titles: [...groups.map((one) => titleOf(one.call)), ownTitle(runner)],
        runs: caseFunction(runner.call),
        at: runner.site,
        markers: [],
        skipped: [...groups, runner].some((one) => one.skipped),
        mocks: mocks
          .filter((one) => one.around.every((site) => inScope.has(site)))
          .map((one) => one.mock),
      },
    ];
  });
}

/** A call and its key. */
interface KeyedCall {
  readonly call: CallOps;
  readonly site: string;
}

/** The calls the file writes that the adapter keys, since a runner call is kept by its key. */
function keyedCalls(module: ModuleOps): KeyedCall[] {
  return module.calls("file").flatMap((call) => {
    const site = call.site?.();
    return site === undefined ? [] : [{ call, site }];
  });
}

function takesNoFixture(): boolean {
  return false;
}

/**
 * The local spelling of each runner function to the name the runner
 * exports it as: the file's imports from `from`, and in a file where the
 * runner's functions are globals, every one the file does not bind at its
 * top level.
 */
function runnerSpellings(
  calls: CallCases,
  module: ModuleOps,
): Map<string, string> {
  const names = runnerNames(calls);
  const spelled = new Map<string, string>();
  for (const [local, exported] of module.importedNames(
    calls.from.importedFrom,
  )) {
    if (names.includes(exported)) {
      spelled.set(local, exported);
    }
  }
  const globals = calls.globalsIn?.matching ?? [];
  if (!matchesTestFileName(module.path(), globals)) {
    return spelled;
  }
  for (const name of names) {
    if (!spelled.has(name) && module.bindsAtTopLevel?.(name) !== true) {
      spelled.set(name, name);
    }
  }
  return spelled;
}

function runnerNames(calls: CallCases): string[] {
  return [
    ...calls.groups.names,
    ...(calls.groups.skipped ?? []),
    ...calls.cases.names,
    ...(calls.cases.skipped ?? []),
  ];
}

/** Whether the call opens a group or declares a case, and how its modifiers mark it. */
function runnerCallOf(
  call: CallOps,
  spelled: ReadonlyMap<string, string>,
  calls: CallCases,
): Omit<RunnerCall, "call" | "site"> | null {
  const callee = runnerCallee(call, calls);
  const canonical = callee === null ? undefined : spelled.get(callee.root);
  if (callee === null || canonical === undefined) {
    return null;
  }
  const skipModifiers = calls.modifiers?.skip ?? [];
  const skipped =
    callee.modifiers.some((modifier) => skipModifiers.includes(modifier)) ||
    (calls.groups.skipped ?? []).includes(canonical) ||
    (calls.cases.skipped ?? []).includes(canonical);
  return { role: roleOf(canonical, calls), skipped, perRow: callee.perRow };
}

/** A spelled name is one of the runner's, so what is no case opens a group. */
function roleOf(canonical: string, calls: CallCases): RunnerCall["role"] {
  const cases = [...calls.cases.names, ...(calls.cases.skipped ?? [])];
  return cases.includes(canonical) ? "case" : "group";
}

/** A callee as the name it starts from and the modifiers written after it. */
interface Chain {
  readonly root: string;
  readonly modifiers: readonly string[];
}

/**
 * The callee's chain, and whether a modifier declares a case per row. A
 * call made on a call, `it.each(rows)("t", fn)`, reads the inner call's
 * chain, which has to end in a modifier that takes arguments. A call
 * written with one of those and nothing after it, `it.each(rows)`, only
 * hands back the function to call, and is no case.
 */
function runnerCallee(
  call: CallOps,
  calls: CallCases,
): (Chain & { readonly perRow: boolean }) | null {
  const direct = chainOf(call);
  if (direct !== null) {
    return takesArguments(lastOf(direct), calls)
      ? null
      : { ...direct, perRow: false };
  }
  const inner = calledOn(call);
  const chain = inner === null ? null : chainOf(inner);
  const last = chain === null ? undefined : lastOf(chain);
  if (chain === null || last === undefined || !takesArguments(last, calls)) {
    return null;
  }
  return { ...chain, perRow: (calls.modifiers?.perRow ?? []).includes(last) };
}

/**
 * The name the callee starts from and the members read after it. A
 * callee written as a name is its own root. A method comes after what
 * its receiver gives: the receiver's spelling when it is written as a
 * name, or else the chain of the member read it is.
 */
function chainOf(call: CallOps): Chain | null {
  if (call.namedCallee?.() === true) {
    return { root: call.calleeText(), modifiers: [] };
  }
  const method = call.method();
  if (method === null) {
    return null;
  }
  const receiver = call.receiverValue?.() ?? null;
  if (receiver?.form?.() === "name") {
    const root = receiver.source?.();
    return root === undefined ? null : { root, modifiers: [method] };
  }
  const member = call.member?.() ?? null;
  const inner = member === null ? null : chainOf(member);
  return inner === null
    ? null
    : { root: inner.root, modifiers: [...inner.modifiers, method] };
}

/** The call the callee is written as in place, when the callee is neither a name nor a method. */
function calledOn(call: CallOps): CallOps | null {
  if (call.namedCallee?.() === true || call.method() !== null) {
    return null;
  }
  return call.callee();
}

function lastOf(chain: Chain): string | undefined {
  return chain.modifiers[chain.modifiers.length - 1];
}

function takesArguments(
  modifier: string | undefined,
  calls: CallCases,
): boolean {
  const modifiers = calls.modifiers;
  return (
    modifier !== undefined &&
    modifiers !== undefined &&
    (modifiers.takingArguments.includes(modifier) ||
      modifiers.perRow.includes(modifier))
  );
}

/** A call or a function, as a step up from it reads it. */
type Written = Pick<CallOps, "passedTo" | "enclosingBody" | "site">;

/** The call the code is passed to in place, or else the body it is written in, or null at the top of the file. */
function enclosing(of: Written): Written | null {
  return of.passedTo?.()?.call ?? of.enclosingBody?.() ?? null;
}

/**
 * The runner calls around a call, outermost first. A walk up stops at the
 * first runner call it meets, whose own are kept by its key, so each case
 * in a group walks only as far as the group.
 */
class RunnersAround {
  private readonly known = new Map<string, readonly RunnerCall[]>();

  constructor(private readonly runners: ReadonlyMap<string, RunnerCall>) {}

  of({ call, site }: KeyedCall): readonly RunnerCall[] {
    const known = this.known.get(site);
    if (known !== undefined) {
      return known;
    }
    const found = this.walkedUp(call);
    this.known.set(site, found);
    return found;
  }

  /** The code a call is written in nests, so the walk ends at the top of the file. */
  private walkedUp(call: CallOps): readonly RunnerCall[] {
    for (let at = enclosing(call); at !== null; at = enclosing(at)) {
      const runner = this.runners.get(at.site?.() ?? "");
      if (runner !== undefined) {
        return [...this.of(runner), runner];
      }
    }
    return [];
  }
}

/** A title the source writes as a string, or else its text as written, kept as unresolved. */
function titleOf(call: CallOps): CaseTitle {
  const first = call.valueAt(0);
  if (first === null) {
    return { text: "", unresolved: true };
  }
  const value = first.evaluated?.() ?? null;
  return typeof value === "string"
    ? { text: value, unresolved: false }
    : { text: first.source?.() ?? "", unresolved: true };
}

/** A case declared once per row keeps its title as written, and that title is the unresolved one. */
function ownTitle(runner: RunnerCall): CaseTitle {
  const title = titleOf(runner.call);
  return runner.perRow ? { text: title.text, unresolved: true } : title;
}

/** The first function passed after the title: `it(title, fn)` or `it(title, options, fn)`. */
function caseFunction(call: CallOps): ValueOps | null {
  for (let at = 1; at < call.argumentCount(); at++) {
    const fn = call.valueAt(at)?.function?.() ?? null;
    if (fn !== null) {
      return fn;
    }
  }
  return null;
}
