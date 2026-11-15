// @suss/framework-react: PatternPack for React function components.
//
// Discovers React function components (default-exported and named),
// classifies JSX-returning terminals as `render` outputs, and
// synthesizes sibling sub-units (event handlers + useEffect bodies)
// via `subUnits`. React's runtime schedules those callbacks distinctly
// from the render body: different inputs, different outputs,
// different firing triggers: so each becomes its own
// BehavioralSummary sharing the component's identity prefix.
//
// Discovery layers:
//   1. `namedExport(["default"])`: cheap data-driven path for the
//      default-export case (anonymous defaults, `export default Cmp`).
//   2. A declared `namedExport` pattern for every other export with a
//      capitalised name whose function returns JSX, outside story and
//      test files.
//
// Deferred: class components, HOC-wrapped defaults, React Server
// Component specifics, custom-hook-as-code-unit discovery (hooks are
// already pickable via dep-call tracking; giving them summaries of
// their own comes later).

import {
  anyOf,
  callbacks,
  constructedFrom,
  declarationsIn,
  describeDiscovery,
  imported,
  subUnitsOf,
} from "@suss/recognize";

import { reactRootComponents } from "./rootDiscovery.js";
import { reactEventHandlers } from "./subUnits.js";

import type { DeclaredDiscoveryPattern, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "2";

const PASS_THROUGH = ["useCallback", "memo", "forwardRef"];

/**
 * A function component a module exports by name. A lowercase export that
 * returns JSX is usually a render helper such as `renderRow`, and story
 * and test files export components that are not the app's.
 */
const COMPONENT_EXPORTS: DeclaredDiscoveryPattern = {
  kind: "component",
  match: {
    type: "namedExport",
    pattern: "^[A-Z]",
    skipFiles: [
      "**/*.stories.ts",
      "**/*.stories.tsx",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
    ],
    bodyEndsIn: "element",
  },
};

/** React's hooks, imported by name or read off the default or namespace import. */
const HOOKS = anyOf(
  constructedFrom("react"),
  imported({ from: ["react"], named: ["default", "*"] }),
);

/**
 * React runs an effect after the render that scheduled it, so each one
 * written in place is a unit of its own, and the component's summary
 * records nothing of it.
 */
const EFFECTS = callbacks({ client: HOOKS })
  .methods({ useEffect: { callback: { written: "callback", at: 0 } } })
  .unitWhenInPlace({
    kind: "handler",
    name: ["parent", "countInParent"],
    countedAs: "effect",
    metadata: {
      react: {
        kind: { reads: "text", text: "effect" },
        component: { reads: "parent" },
        index: { reads: "count" },
        deps: { reads: "argumentItems", at: 1 },
      },
    },
  })
  .example("useEffect(() => { document.title = label; }, [label])");

const EFFECT_UNITS = subUnitsOf([EFFECTS]);

export function reactFramework(): PatternPack {
  return {
    name: "react",
    version: VERSION,
    languages: ["typescript", "javascript"],
    // React doesn't have its own wire protocol: it's a framework
    // running inside a JS runtime, and its boundaries
    // (component ↔ DOM, render ↔ handler, etc.) don't cross a
    // network hop. `"in-process"` is the name for that transport class and
    // will be shared with future in-process packs (custom hooks,
    // module-internal cross-unit work). Framework identity stays on
    // `BoundaryBinding.framework` = "react": that's what
    // distinguishes React-rendered boundaries from, say, a Preact
    // pack or an arbitrary TS function-call boundary.
    protocol: "in-process",

    discovery: [
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
        // Empty gate: under the current JSX runtime, a file can export a
        // component with no explicit `react` import at all. The named-export
        // walk only looks at default exports, so paying for the dispatch on
        // every file is better than missing those files.
        requiresImport: [],
      },
      COMPONENT_EXPORTS,
    ],

    terminals: [
      {
        // A return statement whose value is a JSX element or fragment.
        // Captures the root element/component name as the render
        // output's identity.
        kind: "render",
        match: { type: "jsxReturn" },
        extraction: {},
      },
      {
        // `return null` (or anything non-JSX) in a component function
        // is React's way of rendering nothing. Classify as a `return`
        // terminal with a null value; the branching infrastructure
        // picks up the guarding condition.
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        // Components can throw: error boundaries up the tree handle
        // it. Record the thrown type so cross-boundary checks have a
        // signal without resolving the specific exception.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      // The first positional parameter is conventionally the props
      // object. When it's destructured (`function X({user, onDelete}: Props)`)
      // each name becomes its own Input with role = the prop name;
      // when not (`function X(props)`), one whole-object Input gets
      // role "props". See `componentProps` in @suss/extractor.
      type: "componentProps",
      paramPosition: 0,
    },

    // Each hands back the function it was given, so a call through the
    // result runs that function. `useMemo` and `lazy` are left out: one
    // returns what its argument returns, the other a module's export.
    transparentWrappers: PASS_THROUGH.map((name) => ({
      module: "react",
      name,
      argument: 0,
    })),

    subUnits: (parent, ctx) => [
      ...reactEventHandlers(parent, ctx),
      ...EFFECT_UNITS(parent, ctx),
    ],
    discoverUnits: reactRootComponents,

    declarations: {
      declarations: [
        describeDiscovery(COMPONENT_EXPORTS),
        ...declarationsIn([EFFECTS]).declarations,
      ],
    },
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-react",
  dependencies: [{ ecosystem: "npm", name: "react" }],
  reads: "React function components, event handlers and \`useEffect\` bodies.",
};

export default reactFramework;
