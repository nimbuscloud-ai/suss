// @suss/framework-react — PatternPack for React function components.
//
// Phase 1.1 scope (see docs/roadmap-react.md): discover function
// components, classify their JSX-returning terminals as `render`
// outputs carrying the root element name, and rely on the adapter's
// existing branching/early-return infrastructure to produce one
// transition per rendered path. Explicitly deferred: prop shape
// extraction, hook analysis, nested render-tree structure, event
// handler body behavior, class components, HOCs, React Server
// Components.
//
// Discovery uses `namedExport: ["default"]` as the initial signal — a
// file whose default export is a component. This matches the React
// Router convention already understood by `@suss/framework-react-router`
// and the predominant codebase layout. Named-export components (e.g.
// `export function UserCard(...)` without being the default) are
// intentionally out of scope for this slice; tackled when we have a
// second signal to prove this discovery rule needs expansion.

import type { PatternPack } from "@suss/extractor";

export function reactFramework(): PatternPack {
  return {
    name: "react",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
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
  };
}

export default reactFramework;
