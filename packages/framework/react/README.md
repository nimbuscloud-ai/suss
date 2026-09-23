# @suss/framework-react

Framework pack for [React](https://react.dev/) function components. It finds components, records a JSX return as a render output, and gives event handlers and effect bodies summaries of their own.

```tsx
export function OrderRow({ order, onDelete }: Props) {
  useEffect(() => {
    track("order-row", order.id);
  }, [order.id]);

  return <button onClick={() => onDelete(order.id)}>Delete</button>;
}
```

## What this package is

`@suss/framework-react` exports a `PatternPack`, which is data the adapter reads. It covers:

- **Discovery** in two layers. The data-driven `namedExport(["default"])` pattern covers default exports, including anonymous ones. A `discoverUnits` callback covers the rest.
- **Terminals**: a JSX return becomes a `render` output that records the root element or component. Any other return becomes a `return` terminal (`return null` is how a component renders nothing). A `throw` is recorded so checks across the boundary have something to go on, since an error boundary further up the tree handles it.
- **Input mapping**: `componentProps` on the first positional parameter. A destructured parameter gives one Input per prop name. A parameter that is not destructured gives a single Input with role `props`.
- **Sub-units**: event handlers and `useEffect` bodies, described below.

The pack sets `protocol: "in-process"`, because a React boundary does not cross the network. The framework is recorded on `BoundaryBinding.framework`, set to `"react"`.

### How components are found

The `discoverUnits` callback runs two walks.

The named-export walk takes every export other than the default whose declaration is a function with a statement that returns JSX. It applies some React conventions, which live in this pack so the extractor stays free of them. It skips `.stories.tsx`, `.test.tsx` and `.spec.tsx` files. It skips the default export, since the data-driven pattern already covers it. And it requires a PascalCase name, because a lowercase export that returns JSX is usually a render-prop helper.

The root walk reads the calls React provides for booting an app: `createRoot` and `hydrateRoot` from `react-dom/client`, and `ReactDOM.render`. It resolves the rendered element back to its declaration and records that as a component. An `App` wired up this way is often exported by nothing. The closure then follows its JSX references, so everything the app renders is reachable from there.

### Sub-units

React runs these callbacks separately from the render body, with different inputs, outputs and triggers, so each one becomes its own `BehavioralSummary` under the component's identity.

- One `handler` unit per JSX prop whose name is `on` followed by an uppercase letter, and whose value resolves to a function written in the project. A reference passed through from props, like `onClick={props.onDelete}`, is skipped, because that handler belongs to another component. A named local function becomes `Component.fnName`. An inline arrow becomes `Component.tag.propName`, with a `#N` suffix when the same element and prop have more than one.
- One `handler` unit per `useEffect(fn, deps?)` call in the component body, named `Component.effect#N`, with `metadata.react.kind` set to `"effect"` and the source text of the deps array recorded. Missing deps come through as `null` (runs again on every render), and `[]` means it runs on mount only. A `useEffect` whose callback is an identifier is skipped, since there is no body to read.

## Not covered yet

Class components, defaults wrapped in a HOC, React Server Component specifics, and custom hooks as code units of their own.

## Where it fits in suss

The pack depends on `@suss/extractor`, for the `PatternPack` type, and on `@suss/adapter-typescript`, since the two callbacks are written against that adapter's discovery and sub-unit contexts. `ts-morph` is a peer dependency, because the root walk reads the AST directly.

## Coverage

![coverage](../../../.github/badges/coverage-react.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
