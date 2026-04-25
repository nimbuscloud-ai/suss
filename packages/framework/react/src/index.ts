// @suss/framework-react — PatternPack for React function components.
//
// Discovers default-exported function components, classifies
// JSX-returning terminals as `render` outputs, and synthesizes
// sibling sub-units (event handlers + useEffect bodies) via
// `subUnits`. React's runtime schedules those callbacks distinctly
// from the render body — different inputs, different outputs,
// different firing triggers — so each becomes its own
// BehavioralSummary sharing the component's identity prefix.
//
// Discovery uses `namedExport: ["default"]` as the initial signal — a
// file whose default export is a component. Named-export components
// (e.g. `export function UserCard(...)` without being the default)
// are deferred until a second signal motivates broader discovery.
//
// Deferred: class components, HOC-wrapped defaults, React Server
// Component specifics, custom-hook-as-code-unit discovery (hooks are
// already pickable via dep-call tracking; promoting them to
// first-class summaries follows in a later phase).

import { reactSubUnits } from "./sub-units.js";

import type { PatternPack } from "@suss/extractor";

export function reactFramework(): PatternPack {
  return {
    name: "react",
    languages: ["typescript", "javascript"],
    // React doesn't have its own wire protocol — it's a framework
    // running inside a JS runtime, and its boundaries
    // (component ↔ DOM, render ↔ handler, etc.) don't cross a
    // network hop. `"in-process"` names that transport class and
    // will be shared with future in-process packs (custom hooks,
    // module-internal cross-unit work). Framework identity stays on
    // `BoundaryBinding.framework` = "react" — that's what
    // distinguishes React-rendered boundaries from, say, a Preact
    // pack or an arbitrary TS function-call boundary.
    protocol: "in-process",

    discovery: [
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
        // Component files virtually always import `react` (even
        // under the new JSX runtime, libraries / hooks bring it
        // in). Misses files that bare-export a component without
        // any react import — rare, and acceptable given the
        // dispatch saving on every non-component file.
        requiresImport: ["react"],
      },
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
        // Components can throw — error boundaries up the tree handle
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

    subUnits: reactSubUnits,
  };
}

export default reactFramework;
