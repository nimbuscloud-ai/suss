// componentExecute.ts: run a generated component in node:vm.
//
// No React dependency: the TSX module is transpiled with the
// TypeScript compiler (classic `jsx: React` emit → `React.createElement`
// calls, CommonJS module emit), and the vm provides a stub
// `React.createElement` that builds a plain tree. Calling the default
// export with a concrete props object yields the observation.

import vm from "node:vm";

import { ts } from "ts-morph";

export type ObservedNode =
  | { type: "element"; tag: string; children: ObservedNode[] }
  | { type: "text"; value: string };

/** `null` = the component rendered nothing (returned null). */
export type ObservedRender = ObservedNode | null;

export type ComponentExecutionResult =
  | { type: "ok"; observed: ObservedRender }
  | { type: "error"; message: string };

type StubChild = ObservedNode | string | number | boolean | null | undefined;

function normalizeChildren(children: StubChild[]): ObservedNode[] {
  const out: ObservedNode[] = [];
  for (const child of children.flat() as StubChild[]) {
    if (child === null || child === undefined || typeof child === "boolean") {
      continue; // React's no-render sentinels
    }
    if (typeof child === "string" || typeof child === "number") {
      out.push({ type: "text", value: String(child) });
      continue;
    }
    out.push(child);
  }
  return out;
}

function stubCreateElement(
  tag: unknown,
  _props: unknown,
  ...children: StubChild[]
): ObservedNode {
  if (typeof tag !== "string") {
    throw new Error(
      `stub createElement got a non-string element type: ${String(tag)}`,
    );
  }
  return { type: "element", tag, children: normalizeChildren(children) };
}

/** Transpile the TSX module once; reusable across the props battery. */
export function transpileComponentModule(moduleSource: string): string {
  return ts.transpileModule(moduleSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

export function executeComponent(
  transpiledSource: string,
  props: Record<string, string>,
): ComponentExecutionResult {
  const moduleRef = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module: moduleRef,
    exports: moduleRef.exports,
    React: { createElement: stubCreateElement },
    props: { ...props },
    __observed: undefined as unknown,
  };

  try {
    vm.runInNewContext(
      `${transpiledSource}\n__observed = module.exports.default(props);`,
      sandbox,
      { timeout: 1000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "error", message: `component threw: ${message}` };
  }

  const observed = sandbox.__observed;
  if (observed === null) {
    return { type: "ok", observed: null };
  }
  if (
    typeof observed === "object" &&
    observed !== null &&
    (observed as { type?: unknown }).type === "element"
  ) {
    return { type: "ok", observed: observed as ObservedNode };
  }
  return {
    type: "error",
    message: `component returned neither null nor an element: ${JSON.stringify(observed)}`,
  };
}
