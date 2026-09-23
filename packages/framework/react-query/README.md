# @suss/framework-react-query

The pack for TanStack Query (`@tanstack/react-query`, and the v3
`react-query` module).

A component that calls `useQuery({ queryKey, queryFn })` reaches an API
through the query function. The HTTP call is inside `queryFn`, and
without this pack nothing ties it to the component. The pack matches
calls to `useQuery`, `useSuspenseQuery`, `useInfiniteQuery`,
`useSuspenseInfiniteQuery` and `useMutation`, and records a schedule
interaction on the calling unit with the function the hook runs.

```ts
const orders = useQuery({ queryKey: ["orders"], queryFn: fetchOrders });
```

- An inline function (`queryFn: async () => { ... }`) becomes a
  `scheduled-callback` sub-unit of the component, so the client packs
  (`fetch`, `axios`) read the HTTP call inside it.
- A named function (`queryFn: fetchOrders`) is recorded by identifier,
  and the walk follows it to that function's own summary.
- The v3 positional forms (`useQuery(key, fn)`, `useMutation(fn)`) are
  read the same way.

## Usage

```bash
suss extract -f react -f react-query -f fetch -p tsconfig.json
```

The react pack finds the components, the client packs read the calls,
and this pack connects the two. It also works alone. A run with only
`-f react-query` reports the schedule effects through the adapter's
closure roots.

The pack only matches hooks imported from `@tanstack/react-query` or
`react-query`, so a project's own function named `useQuery` is never
mistaken for the library's.

## What v0 leaves out

- `useQueries` and the `queryOptions` helper.
- Query keys. suss does not record the key yet, so two components that
  share a cache entry are not paired by key.
- RTK Query and SWR. They are different libraries and get their own
  packs.
