# @suss/framework-react

Framework pack for [React](https://react.dev/) function components. It discovers components, classifies JSX returns as render outputs, and gives event handlers and effect bodies summaries of their own.

## What this package is

`@suss/framework-react` returns a `PatternPack` object describing:

- **Discovery** in two layers. The data-driven `namedExport(["default"])` pattern covers default exports, including anonymous ones. A `discoverUnits` callback covers the rest.
- **Terminals**: a JSX return becomes a `render` output capturing the root element or component; any other return becomes a `return` terminal (`return null` is how a component renders nothing); `throw` is recorded so cross-boundary checks have a signal, since an error boundary up the tree handles it.
- **Input mapping**: `componentProps` on the first positional parameter. A destructured parameter gives one Input per prop name; an undestructured one gives a single Input with role `props`.
- **Sub-units**: event handlers and `useEffect` bodies, described below.

The pack sets `protocol: "in-process"`. React boundaries do not cross a network hop, and framework identity stays on `BoundaryBinding.framework` set to `"react"`.

### How components are found

The `discoverUnits` callback runs two walks.

The named-export walk takes every non-default export whose declaration is a function with a JSX-returning statement, after applying React conventions the pack owns rather than the extractor. It skips `.stories.tsx` and `.test.tsx` / `.spec.tsx` files, skips the default export (the data-driven pattern already has it), and requires a PascalCase name, since a lowercase export returning JSX is usually a render-prop helper.

The root walk reads the boot calls React ships, `createRoot` and `hydrateRoot` from `react-dom/client`, and `ReactDOM.render`. It resolves the rendered element back to its declaration and emits it as a component. An `App` wired this way is often exported by nothing, and the closure then follows its JSX references, so everything the app renders is reachable from there.

### Sub-units

React's runtime schedules callbacks separately from the render body, with different inputs, outputs, and triggers, so each one becomes its own `BehavioralSummary` under the component's identity.

- One `handler` unit per JSX prop whose name looks like `on` followed by an uppercase letter and whose value resolves to a locally-authored function. A prop-delegating reference like `onClick={props.onDelete}` is skipped, because that handler belongs to somebody else. A named local becomes `Component.fnName`; an inline arrow becomes `Component.tag.propName`, with a `#N` suffix when the same element and prop have more than one.
- One `handler` unit per `useEffect(fn, deps?)` call in the component body, named `Component.effect#N`, with `metadata.react.kind` set to `"effect"` and the deps-array source text recorded. Absent deps come through as `null` (re-runs every render) and `[]` means mount-only. A `useEffect` whose callback is an identifier reference is skipped, since there is no body to read.

## Not covered yet

Class components, HOC-wrapped defaults, React Server Component specifics, and custom hooks as code units of their own.

## Where it fits in suss

Depends on `@suss/extractor` (for the `PatternPack` type) and `@suss/adapter-typescript`, whose discovery and sub-unit contexts the two callbacks are written against. `ts-morph` is a peer dependency, since the root walk reads the AST directly.

## Coverage

![coverage](../../../.github/badges/coverage-react.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
