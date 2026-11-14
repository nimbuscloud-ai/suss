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

- **Discovery** in three layers. The data-driven `namedExport(["default"])` pattern covers default exports, including anonymous ones. A declared `namedExport` pattern covers every other export that is a component, and a `discoverUnits` callback finds the component an app boots with.
- **Terminals**: a JSX return becomes a `render` output that records the root element or component. Any other return becomes a `return` terminal (`return null` is how a component renders nothing). A `throw` is recorded so checks across the boundary have something to go on, since an error boundary further up the tree handles it.
- **Input mapping**: `componentProps` on the first positional parameter. A destructured parameter gives one Input per prop name. A parameter that is not destructured gives a single Input with role `props`.
- **Sub-units**: event handlers and `useEffect` bodies, described below.

The pack sets `protocol: "in-process"`, because a React boundary does not cross the network. The framework is recorded on `BoundaryBinding.framework`, set to `"react"`.

### How components are found

The declared `namedExport` pattern, which `@suss/recognize` reads, takes every export whose name matches `^[A-Z]` and whose function returns a JSX element or fragment from its own body. A lowercase export that returns JSX is usually a render-prop helper, so it is left out, and so is the default export, which the first pattern covers. Exports of `.stories`, `.test` and `.spec` files with a `.ts` or `.tsx` extension are left out too, since those files export components that are not the app's.

The pack declares `useCallback`, `memo` and `forwardRef` as transparent wrappers, since each hands back the function it was given. An export written as `memo(Card)` is then the `Card` function, and a call through a hook's `useCallback` result runs the callback. A cast around the export or around the returned JSX is read through, so `forwardRef(Picker) as <T>(props: Props<T>) => JSX.Element`, which is how a generic component keeps its type parameter, is the `Picker` function. An export a project factory makes, such as `export const Label = styledDiv("label")`, is the component the factory gives back.

The `discoverUnits` callback reads the calls React provides for booting an app: `createRoot` and `hydrateRoot` from `react-dom/client`, and `ReactDOM.render`. It resolves the rendered element back to its declaration and records that as a component. An `App` wired up this way is often exported by nothing. The closure then follows its JSX references, so everything the app renders is reachable from there.

### Sub-units

React runs these callbacks separately from the render body, with different inputs, outputs and triggers, so each one becomes its own `BehavioralSummary` under the component's identity.

- One `handler` unit per JSX prop whose name is `on` followed by an uppercase letter, and whose value resolves to a function written in the project. A reference passed through from props, like `onClick={props.onDelete}`, is skipped, because that handler belongs to another component. A named local function becomes `Component.fnName`. An inline arrow becomes `Component.tag.propName`, with a `#N` suffix when the same element and prop have more than one.
- One `handler` unit per `useEffect(fn, deps?)` call in the component body, named `Component.effect#N`, with `metadata.react.kind` set to `"effect"` and the source text of the deps array recorded. Missing deps come through as `null` (runs again on every render), and `[]` means it runs on mount only. `React.useEffect(...)` off a default or namespace import of `react`, and an aliased import such as `useEffect as useMount`, count the same. A bare `useEffect` counts when it was imported from `react`, directly or through a project file that re-exports it, so Preact's hook or a project's own function of that name gets no unit. A `useEffect` whose callback is an identifier is skipped, since there is no body to read. The callback and the deps are read through parentheses and casts, so `[id] as const` records `id`.

## Not covered yet

Class components, defaults wrapped in a HOC, React Server Component specifics, and custom hooks as code units of their own.

## Where it fits in suss

The pack depends on `@suss/extractor`, for the `PatternPack` type, on `@suss/recognize`, which reads its declared pattern, and on `@suss/adapter-typescript`, since the two callbacks are written against that adapter's discovery and sub-unit contexts. `ts-morph` is a peer dependency, because the boot walk reads the AST directly.

## Coverage

![coverage](../../../.github/badges/coverage-react.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
