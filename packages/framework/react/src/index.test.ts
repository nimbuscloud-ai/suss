import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { reactFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — loads fixtures/react/*.tsx in memory
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/react");

function runAdapter(): BehavioralSummary[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
      // React 17+ automatic runtime; adapter doesn't actually render, just
      // parses JSX, but the compiler needs a JSX mode configured.
      jsx: 4, // ReactJSX
    },
  });
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.tsx"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [reactFramework()],
  });

  return adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Pack-shape structural checks
// ---------------------------------------------------------------------------

describe("reactFramework — pack shape", () => {
  it("exposes component discovery via the default export", () => {
    const pack = reactFramework();
    expect(pack.name).toBe("react");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].kind).toBe("component");
    expect(pack.discovery[0].match).toEqual({
      type: "namedExport",
      names: ["default"],
    });
  });

  it("declares a jsxReturn terminal for render outputs", () => {
    const pack = reactFramework();
    const jsxTerminal = pack.terminals.find((t) => t.kind === "render");
    expect(jsxTerminal).toBeDefined();
    expect(jsxTerminal?.match).toEqual({ type: "jsxReturn" });
  });

  it("declares componentProps input mapping at position 0", () => {
    const pack = reactFramework();
    if (pack.inputMapping.type !== "componentProps") {
      throw new Error("expected componentProps");
    }
    expect(pack.inputMapping.paramPosition).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the JSX fixtures
// ---------------------------------------------------------------------------

describe("reactFramework — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(() => {
    summaries = runAdapter();
  }, 90_000);

  it("discovers every default-exported component", () => {
    const components = summaries.filter((s) => s.kind === "component");
    const names = components.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "Button",
      "Conditional",
      "Counter",
      "EffectyComponent",
      "Form",
      "Greeting",
      "Nav",
      "UserCard",
    ]);
  });

  it("Counter emits one Input per destructured prop (role = prop name, type resolved)", () => {
    const counter = summaries.find((s) => s.identity.name === "Counter");
    expect(counter).toBeDefined();
    const inputs = counter?.inputs;
    const byName = new Map(
      inputs.map((i) => {
        if (i.type !== "parameter") {
          throw new Error("expected parameter input");
        }
        return [i.name, i] as const;
      }),
    );
    expect([...byName.keys()].sort()).toEqual(["initial", "label", "onChange"]);
    expect(byName.get("label")?.role).toBe("label");
    expect(byName.get("initial")?.role).toBe("initial");
    expect(byName.get("onChange")?.role).toBe("onChange");

    // Types come back as named-ref TypeShapes whose `.name` is the
    // TypeScript-printed type. Exact formatting varies slightly across
    // ts-morph versions, so assert on key substrings rather than
    // exact-string match.
    const labelShape = byName.get("label")?.shape;
    expect(labelShape?.type).toBe("ref");
    if (labelShape?.type === "ref") {
      expect(labelShape.name).toContain("string");
    }
    const initialShape = byName.get("initial")?.shape;
    if (initialShape?.type === "ref") {
      expect(initialShape.name).toContain("number");
    }
    const onChangeShape = byName.get("onChange")?.shape;
    if (onChangeShape?.type === "ref") {
      expect(onChangeShape.name).toContain("=>"); // arrow-function type
    }
  });

  it("Greeting emits a single whole-object Input (non-destructured)", () => {
    const greeting = summaries.find((s) => s.identity.name === "Greeting");
    expect(greeting).toBeDefined();
    const inputs = greeting?.inputs;
    expect(inputs).toHaveLength(1);
    if (inputs[0].type !== "parameter") {
      throw new Error("expected parameter input");
    }
    expect(inputs[0].name).toBe("props");
    expect(inputs[0].role).toBe("props");
  });

  it("UserCard has two transitions: early-return-null and render div", () => {
    const userCard = summaries.find((s) => s.identity.name === "UserCard");
    expect(userCard).toBeDefined();
    const transitions = userCard?.transitions;
    // Source order: early return null first, then render path
    expect(transitions).toHaveLength(2);
    expect(transitions[0].output.type).toBe("return");
    expect(transitions[1].output.type).toBe("render");
    if (transitions[1].output.type === "render") {
      expect(transitions[1].output.component).toBe("div");
    }
    // The render path is the fall-through (no extra condition beyond
    // the implicit negation of the early return).
    expect(transitions[1].isDefault).toBe(true);
  });

  it("Nav renders a fragment (root element name is 'Fragment')", () => {
    const nav = summaries.find((s) => s.identity.name === "Nav");
    expect(nav).toBeDefined();
    expect(nav?.transitions).toHaveLength(1);
    const out = nav?.transitions[0].output;
    expect(out.type).toBe("render");
    if (out.type === "render") {
      expect(out.component).toBe("Fragment");
    }
  });

  it("Button renders a self-closing element wrapped in parens", () => {
    const button = summaries.find((s) => s.identity.name === "Button");
    expect(button).toBeDefined();
    expect(button?.transitions).toHaveLength(1);
    const out = button?.transitions[0].output;
    expect(out.type).toBe("render");
    // <button type="button">...</button> is a regular (not self-closing)
    // JSX element — exercised to confirm getTagNameNode works across
    // both shapes.
    if (out.type === "render") {
      expect(out.component).toBe("button");
    }
  });

  // -------------------------------------------------------------------
  // Phase 1.6: nested render tree (Output.render.root)
  // -------------------------------------------------------------------

  it("UserCard's render branch carries a tree with the dynamic child as an expression node", () => {
    const userCard = summaries.find((s) => s.identity.name === "UserCard");
    expect(userCard).toBeDefined();
    const renderTxn = userCard?.transitions[1];
    expect(renderTxn.output.type).toBe("render");
    if (renderTxn.output.type !== "render") {
      throw new Error("expected render");
    }
    const root = renderTxn.output.root;
    expect(root).toBeDefined();
    expect(root?.type).toBe("element");
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.tag).toBe("div");
    // `<div>{user.name}</div>` — one dynamic expression child carrying
    // the original source text.
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toEqual({
      type: "expression",
      sourceText: "user.name",
    });
  });

  it("Nav's fragment root contains two anchor elements with trimmed text children", () => {
    const nav = summaries.find((s) => s.identity.name === "Nav");
    const out = nav?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.tag).toBe("Fragment");
    // Two child elements; whitespace-only text between them is stripped.
    const aTags = root.children.filter(
      (c) => c.type === "element" && c.tag === "a",
    );
    expect(aTags).toHaveLength(2);
    const first = aTags[0];
    if (first.type !== "element") {
      throw new Error("expected element");
    }
    expect(first.children).toEqual([{ type: "text", value: "Home" }]);
  });

  it("Counter's render tree mixes elements, text, and dynamic expressions", () => {
    const counter = summaries.find((s) => s.identity.name === "Counter");
    const out = counter?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.tag).toBe("div");
    // <div> children: <span>{label}</span>, <button>...</button>
    const elementChildren = root.children.filter((c) => c.type === "element");
    expect(elementChildren).toHaveLength(2);
    const span = elementChildren[0];
    if (span.type !== "element") {
      throw new Error("expected element");
    }
    expect(span.tag).toBe("span");
    expect(span.children).toEqual([
      { type: "expression", sourceText: "label" },
    ]);
  });

  // -------------------------------------------------------------------
  // Phase 1.4: inline JSX conditionals
  // -------------------------------------------------------------------

  it("Conditional decomposes `{isLoading && <span/>}` into a conditional with a null else", () => {
    const conditional = summaries.find(
      (s) => s.identity.name === "Conditional",
    );
    expect(conditional).toBeDefined();
    const out = conditional?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const loadingBranch = root.children[0];
    expect(loadingBranch).toBeDefined();
    if (loadingBranch.type !== "conditional") {
      throw new Error("expected conditional for `&&` JSX child");
    }
    expect(loadingBranch.condition).toBe("isLoading");
    expect(loadingBranch.whenFalse).toBeNull();
    if (loadingBranch.whenTrue.type !== "element") {
      throw new Error("expected element `whenTrue`");
    }
    expect(loadingBranch.whenTrue.tag).toBe("span");
  });

  it("Conditional decomposes `{error ? <div/> : <div/>}` into a conditional with both branches", () => {
    const conditional = summaries.find(
      (s) => s.identity.name === "Conditional",
    );
    const out = conditional?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const errBranch = root.children[1];
    if (errBranch.type !== "conditional") {
      throw new Error("expected conditional for ternary JSX child");
    }
    expect(errBranch.condition).toBe("error");
    if (errBranch.whenTrue.type !== "element") {
      throw new Error("expected element `whenTrue`");
    }
    expect(errBranch.whenTrue.tag).toBe("div");
    if (errBranch.whenFalse?.type !== "element") {
      throw new Error("expected element `whenFalse`");
    }
    expect(errBranch.whenFalse.tag).toBe("div");
  });

  it("Conditional decomposes `{... ? <ul/> : null}` with a null else", () => {
    const conditional = summaries.find(
      (s) => s.identity.name === "Conditional",
    );
    const out = conditional?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const listBranch = root.children[2];
    if (listBranch.type !== "conditional") {
      throw new Error(
        "expected conditional for `items.length > 0 ? ... : null`",
      );
    }
    expect(listBranch.condition).toBe("items.length > 0");
    expect(listBranch.whenFalse).toBeNull();
    if (listBranch.whenTrue.type !== "element") {
      throw new Error("expected element `whenTrue`");
    }
    expect(listBranch.whenTrue.tag).toBe("ul");
  });

  // -------------------------------------------------------------------
  // Phase 1.5: event handlers as separate code units
  // -------------------------------------------------------------------

  it("Counter's inline onClick becomes its own handler code unit", () => {
    const handler = summaries.find(
      (s) => s.identity.name === "Counter.button.onClick",
    );
    expect(handler).toBeDefined();
    expect(handler?.kind).toBe("handler");
    const meta = handler?.metadata?.react as
      | {
          kind: string;
          component: string;
          elementTag: string;
          propName: string;
          localName?: string;
        }
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.component).toBe("Counter");
    expect(meta?.elementTag).toBe("button");
    expect(meta?.propName).toBe("onClick");
    expect(meta?.localName).toBeUndefined();
  });

  it("Form's named handler uses the declaration's identifier", () => {
    const handler = summaries.find(
      (s) => s.identity.name === "Form.handleSubmit",
    );
    expect(handler).toBeDefined();
    expect(handler?.kind).toBe("handler");
    const meta = handler?.metadata?.react as
      | { propName: string; elementTag: string; localName?: string }
      | undefined;
    expect(meta?.propName).toBe("onSubmit");
    expect(meta?.elementTag).toBe("form");
    expect(meta?.localName).toBe("handleSubmit");
  });

  it("Form disambiguates two inline onClick handlers on <button>", () => {
    const names = summaries
      .map((s) => s.identity.name)
      .filter((n) => n.startsWith("Form.button.onClick"))
      .sort();
    // Two anonymous button.onClick handlers → two #N-suffixed names;
    // the third button's `onClick={props.onDelete}` is a prop
    // delegation, not a locally-authored handler, so it is not
    // synthesized.
    expect(names).toEqual(["Form.button.onClick#0", "Form.button.onClick#1"]);
  });

  it("Form's unique input.onChange handler has no disambiguation suffix", () => {
    const handler = summaries.find(
      (s) => s.identity.name === "Form.input.onChange",
    );
    expect(handler).toBeDefined();
    expect(handler?.kind).toBe("handler");
  });

  it("does not synthesize handlers for prop-delegating onClick refs", () => {
    const propDelegated = summaries.filter(
      (s) =>
        s.kind === "handler" &&
        (s.metadata?.react as { propName?: string } | undefined)?.propName ===
          "onClick" &&
        s.identity.name.includes("onDelete"),
    );
    expect(propDelegated).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Phase 1.7: useEffect bodies as code units
  // -------------------------------------------------------------------

  it("synthesizes one summary per useEffect call, indexed in source order", () => {
    const effects = summaries.filter(
      (s) =>
        (s.metadata?.react as { kind?: string } | undefined)?.kind === "effect",
    );
    const names = effects.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "EffectyComponent.effect#0",
      "EffectyComponent.effect#1",
      "EffectyComponent.effect#2",
    ]);
  });

  it("useEffect summaries record their dependency arrays in metadata", () => {
    type EffectMeta = {
      kind: string;
      component: string;
      index: number;
      deps: string[] | null;
    };
    const first = summaries.find(
      (s) => s.identity.name === "EffectyComponent.effect#0",
    );
    const firstMeta = first?.metadata?.react as EffectMeta | undefined;
    expect(firstMeta?.deps).toEqual([]);

    const second = summaries.find(
      (s) => s.identity.name === "EffectyComponent.effect#1",
    );
    const secondMeta = second?.metadata?.react as EffectMeta | undefined;
    expect(secondMeta?.deps).toEqual(["userId"]);

    const third = summaries.find(
      (s) => s.identity.name === "EffectyComponent.effect#2",
    );
    const thirdMeta = third?.metadata?.react as EffectMeta | undefined;
    // No deps argument → every-render semantics. Represented as null
    // (distinct from `[]` which means mount-only).
    expect(thirdMeta?.deps).toBeNull();
  });

  it("useEffect summaries are handler-kind with react boundary binding", () => {
    const effect = summaries.find(
      (s) => s.identity.name === "EffectyComponent.effect#0",
    );
    expect(effect?.kind).toBe("handler");
    expect(effect?.identity.boundaryBinding?.recognition).toBe("react");
    // React uses the "in-process" transport class — no network hop.
    expect(effect?.identity.boundaryBinding?.transport).toBe("in-process");
  });

  it("handler summaries carry a react boundary binding", () => {
    const handler = summaries.find(
      (s) => s.identity.name === "Counter.button.onClick",
    );
    expect(handler?.identity.boundaryBinding?.recognition).toBe("react");
    expect(handler?.identity.boundaryBinding?.transport).toBe("in-process");
  });

  // -------------------------------------------------------------------
  // Phase 1.5b: effect-body capture + fall-through terminals
  // -------------------------------------------------------------------

  it("Counter's onClick handler has a default transition (fall-through)", () => {
    // Counter's onClick body does side-effect work and falls off the
    // end — no explicit return. Without the fall-through opt-in, this
    // would show up with `transitions: []`.
    const handler = summaries.find(
      (s) => s.identity.name === "Counter.button.onClick",
    );
    expect(handler?.transitions.length).toBeGreaterThan(0);
    const defaultTxn = handler?.transitions.find((t) => t.isDefault);
    expect(defaultTxn).toBeDefined();
  });

  it("Counter's onClick handler carries `setCount` and `onChange` as invocation effects", () => {
    const handler = summaries.find(
      (s) => s.identity.name === "Counter.button.onClick",
    );
    const defaultTxn = handler?.transitions.find((t) => t.isDefault);
    const callees = defaultTxn?.effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null))
      .filter((s): s is string => s !== null);
    expect(callees).toContain("setCount");
    expect(callees).toContain("onChange");
  });

  it("EffectyComponent's useEffect#0 body carries setValue as an invocation effect", () => {
    const effect = summaries.find(
      (s) => s.identity.name === "EffectyComponent.effect#0",
    );
    const defaultTxn = effect?.transitions.find((t) => t.isDefault);
    const callees = defaultTxn?.effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    expect(callees).toContain("setValue");
  });

  // -------------------------------------------------------------------
  // Phase 1.6b: JSX attributes on render-tree element nodes
  // -------------------------------------------------------------------

  it("Counter's button element carries type and onClick attrs on its render node", () => {
    const counter = summaries.find((s) => s.identity.name === "Counter");
    const out = counter?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    const button = root.children.find(
      (c) => c.type === "element" && c.tag === "button",
    );
    if (button?.type !== "element") {
      throw new Error("expected button element");
    }
    expect(button.attrs).toBeDefined();
    // String-literal attribute keeps its quotes — raw source text.
    expect(button.attrs?.type).toBe('"button"');
    // Expression attribute keeps the full expression source text, so
    // downstream matchers can resolve it to a handler summary name
    // using the React pack's naming rule.
    expect(button.attrs?.onClick).toContain("setCount");
    expect(button.attrs?.onClick).toContain("onChange");
  });

  it("UserCard's div element omits attrs entirely when empty", () => {
    const userCard = summaries.find((s) => s.identity.name === "UserCard");
    // UserCard returns `<div>{user.name}</div>` — no attrs.
    const renderTxn = userCard?.transitions[1];
    const out = renderTxn.output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.tag).toBe("div");
    expect(root.attrs).toBeUndefined();
  });

  it("Form's form element carries onSubmit attr referencing the local handler", () => {
    const form = summaries.find((s) => s.identity.name === "Form");
    const out = form?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.tag).toBe("form");
    // Named identifier reference — the React pack's naming rule
    // maps this to `Form.handleSubmit` via subUnits; here we verify
    // the tree carries the raw identifier for consumers to resolve.
    expect(root.attrs?.onSubmit).toBe("handleSubmit");
  });

  it("Greeting's single-element render tree has text and expression children", () => {
    const greeting = summaries.find((s) => s.identity.name === "Greeting");
    const out = greeting?.transitions[0].output;
    if (out.type !== "render") {
      throw new Error("expected render");
    }
    const root = out.root;
    if (root?.type !== "element") {
      throw new Error("expected element root");
    }
    expect(root.tag).toBe("div");
    // Order preserved: "Hello," text, then {props.name} expression.
    expect(root.children[0]).toEqual({ type: "text", value: "Hello," });
    expect(root.children[1]).toEqual({
      type: "expression",
      sourceText: "props.name",
    });
  });
});
