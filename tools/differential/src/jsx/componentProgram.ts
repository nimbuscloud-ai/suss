// componentProgram.ts — the generated-component DSL and its renderer.
//
// The render-boundary sibling of the handler DSL (../program.ts): a
// `ComponentProgram` covers the constructs the React pack claims to
// model — destructured string props, early-return guards (`return
// null` / `return <jsx/>`), and a JSX tree with inline conditionals
// (`{cond && <X/>}`, `{cond ? <A/> : <B/>}`). One program renders to
// two views that cannot drift: a TSX module for extraction and the
// same module transpiled for vm execution.

import { type DispatchTable, dispatchByType } from "../dispatch.js";

/** Conditions over props. All generated props are typed `string`. */
export type PropCond =
  | { type: "truthy"; prop: string; negated: boolean }
  | { type: "eq"; prop: string; value: string; negated: boolean }
  | { type: "and"; left: PropCond; right: PropCond }
  | { type: "or"; left: PropCond; right: PropCond };

export type JsxNode =
  | { type: "element"; tag: string; children: JsxNode[] }
  | { type: "text"; value: string }
  /** `{prop}` interpolation — renders the prop's string value. */
  | { type: "propText"; prop: string }
  /** `{cond && <child/>}` */
  | { type: "logical"; cond: PropCond; child: JsxNode }
  /** `{cond ? <A/> : <B/>}` — `whenFalse: null` renders the `: null` form. */
  | {
      type: "ternary";
      cond: PropCond;
      whenTrue: JsxNode;
      whenFalse: JsxNode | null;
    };

export interface JsxElement {
  type: "element";
  tag: string;
  children: JsxNode[];
}

export type ComponentGuard =
  | { type: "guardNull"; cond: PropCond }
  | { type: "guardJsx"; cond: PropCond; node: JsxElement }
  /**
   * Gap-tier construct: a guard one block deep —
   * `if (outer) { if (inner) { return null; } }`. Same documented
   * nested-guard soundness gap as the HTTP DSL's `nestedGuard`; the
   * adapter machinery is shared, so the gap manifests at the render
   * boundary too.
   */
  | { type: "nestedGuardNull"; outer: PropCond; inner: PropCond };

export interface ComponentProgram {
  /** Declared prop names (superset of the names conditions use). */
  props: string[];
  guards: ComponentGuard[];
  root: JsxElement;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const isCompositeCond = (cond: PropCond): boolean =>
  cond.type === "and" || cond.type === "or";

function renderCondOperand(cond: PropCond): string {
  const text = renderPropCond(cond);
  return isCompositeCond(cond) ? `(${text})` : text;
}

const COND_RENDERERS: DispatchTable<PropCond, string> = {
  truthy: (cond) => (cond.negated ? `!${cond.prop}` : cond.prop),
  eq: (cond) =>
    `${cond.prop} ${cond.negated ? "!==" : "==="} ${JSON.stringify(cond.value)}`,
  and: (cond) =>
    `${renderCondOperand(cond.left)} && ${renderCondOperand(cond.right)}`,
  or: (cond) =>
    `${renderCondOperand(cond.left)} || ${renderCondOperand(cond.right)}`,
};

export function renderPropCond(cond: PropCond): string {
  return dispatchByType(COND_RENDERERS, cond);
}

// JSX is rendered with no inter-child whitespace: whitespace-only text
// between elements is dropped by the JSX transform but not by string
// comparison, so tight packing keeps the executed tree and the claimed
// tree aligned on the same child list.
const NODE_RENDERERS: DispatchTable<JsxNode, string> = {
  element: (node) =>
    node.children.length === 0
      ? `<${node.tag}/>`
      : `<${node.tag}>${node.children.map(renderJsxNode).join("")}</${node.tag}>`,
  text: (node) => node.value,
  propText: (node) => `{${node.prop}}`,
  logical: (node) =>
    `{${renderCondOperand(node.cond)} && ${renderJsxNode(node.child)}}`,
  ternary: (node) => {
    const whenFalse =
      node.whenFalse === null ? "null" : renderJsxNode(node.whenFalse);
    return `{${renderCondOperand(node.cond)} ? ${renderJsxNode(node.whenTrue)} : ${whenFalse}}`;
  },
};

export function renderJsxNode(node: JsxNode): string {
  return dispatchByType(NODE_RENDERERS, node);
}

const GUARD_RENDERERS: DispatchTable<ComponentGuard, string[]> = {
  guardNull: (guard) => [
    `if (${renderPropCond(guard.cond)}) {`,
    "  return null;",
    "}",
  ],
  guardJsx: (guard) => [
    `if (${renderPropCond(guard.cond)}) {`,
    `  return ${renderJsxNode(guard.node)};`,
    "}",
  ],
  nestedGuardNull: (guard) => [
    `if (${renderPropCond(guard.outer)}) {`,
    `  if (${renderPropCond(guard.inner)}) {`,
    "    return null;",
    "  }",
    "}",
  ],
};

/** The TSX module — what the extraction pipeline sees (and, transpiled, what runs). */
export function renderComponentModule(program: ComponentProgram): string {
  const propsInterface =
    program.props.length === 0
      ? "interface Props {}"
      : [
          "interface Props {",
          ...program.props.map((prop) => `  ${prop}: string;`),
          "}",
        ].join("\n");
  const destructured =
    program.props.length === 0 ? "" : `{ ${program.props.join(", ")} }`;
  const params = program.props.length === 0 ? "" : `${destructured}: Props`;
  const body = [
    ...program.guards.flatMap((guard) =>
      dispatchByType(GUARD_RENDERERS, guard),
    ),
    `return ${renderJsxNode(program.root)};`,
  ]
    .map((line) => `  ${line}`)
    .join("\n");

  return [
    propsInterface,
    "",
    `export default function Generated(${params}) {`,
    body,
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Prop collection — which props do conditions observe?
// ---------------------------------------------------------------------------

function condProps(cond: PropCond): string[] {
  const table: DispatchTable<PropCond, string[]> = {
    truthy: (c) => [c.prop],
    eq: (c) => [c.prop],
    and: (c) => [...condProps(c.left), ...condProps(c.right)],
    or: (c) => [...condProps(c.left), ...condProps(c.right)],
  };
  return dispatchByType(table, cond);
}

function nodeProps(node: JsxNode): string[] {
  const table: DispatchTable<JsxNode, string[]> = {
    element: (n) => n.children.flatMap(nodeProps),
    text: () => [],
    propText: (n) => [n.prop],
    logical: (n) => [...condProps(n.cond), ...nodeProps(n.child)],
    ternary: (n) => [
      ...condProps(n.cond),
      ...nodeProps(n.whenTrue),
      ...(n.whenFalse === null ? [] : nodeProps(n.whenFalse)),
    ],
  };
  return dispatchByType(table, node);
}

const GUARD_PROPS: DispatchTable<ComponentGuard, string[]> = {
  guardNull: (guard) => condProps(guard.cond),
  guardJsx: (guard) => [...condProps(guard.cond), ...nodeProps(guard.node)],
  nestedGuardNull: (guard) => [
    ...condProps(guard.outer),
    ...condProps(guard.inner),
  ],
};

/** Props observed by any condition in the program (guards + tree). */
export function collectObservedProps(program: ComponentProgram): string[] {
  const raw = [
    ...program.guards.flatMap((guard) => dispatchByType(GUARD_PROPS, guard)),
    ...nodeProps(program.root),
  ];
  return [...new Set(raw)];
}

function condComparedValues(cond: PropCond, prop: string): string[] {
  const table: DispatchTable<PropCond, string[]> = {
    truthy: () => [],
    eq: (c) => (c.prop === prop ? [c.value] : []),
    and: (c) => [
      ...condComparedValues(c.left, prop),
      ...condComparedValues(c.right, prop),
    ],
    or: (c) => [
      ...condComparedValues(c.left, prop),
      ...condComparedValues(c.right, prop),
    ],
  };
  return dispatchByType(table, cond);
}

function nodeComparedValues(node: JsxNode, prop: string): string[] {
  const table: DispatchTable<JsxNode, string[]> = {
    element: (n) => n.children.flatMap((c) => nodeComparedValues(c, prop)),
    text: () => [],
    propText: () => [],
    logical: (n) => [
      ...condComparedValues(n.cond, prop),
      ...nodeComparedValues(n.child, prop),
    ],
    ternary: (n) => [
      ...condComparedValues(n.cond, prop),
      ...nodeComparedValues(n.whenTrue, prop),
      ...(n.whenFalse === null ? [] : nodeComparedValues(n.whenFalse, prop)),
    ],
  };
  return dispatchByType(table, node);
}

/** Literals a prop is compared against anywhere in the program. */
export function collectComparedPropValues(
  program: ComponentProgram,
  prop: string,
): string[] {
  const guardCompared: DispatchTable<ComponentGuard, string[]> = {
    guardNull: (guard) => condComparedValues(guard.cond, prop),
    guardJsx: (guard) => [
      ...condComparedValues(guard.cond, prop),
      ...nodeComparedValues(guard.node, prop),
    ],
    nestedGuardNull: (guard) => [
      ...condComparedValues(guard.outer, prop),
      ...condComparedValues(guard.inner, prop),
    ],
  };
  const values = [
    ...program.guards.flatMap((guard) => dispatchByType(guardCompared, guard)),
    ...nodeComparedValues(program.root, prop),
  ];
  return [...new Set(values)];
}
