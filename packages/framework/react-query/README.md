# @suss/framework-react-query

The PatternPack for TanStack Query (`@tanstack/react-query`, and the
v3 `react-query` module).

A component calling `useQuery({ queryKey, queryFn })` reaches an API
through the query function, and without this pack that reach is
invisible: the HTTP call lives in `queryFn` and nothing ties it to the
component. The pack recognizes `useQuery`, `useSuspenseQuery`,
`useInfiniteQuery`, `useSuspenseInfiniteQuery`, and `useMutation`
calls and emits a schedule interaction on the calling unit saying
which function the hook runs.

- An inline function (`queryFn: async () => { ... }`) becomes a
  `scheduled-callback` sub-unit of the component, so the client packs
  (`fetch`, `axios`) read the HTTP call inside it.
- A named function (`queryFn: fetchOrders`) is recorded by identifier,
  and the walk follows it to the function's own summary.
- The v3 positional forms (`useQuery(key, fn)`, `useMutation(fn)`) are
  read the same way.

## Usage

```bash
suss extract -f react -f react-query -f fetch -p tsconfig.json
```

The react pack finds the components and the client packs read the
calls; this pack is the tie between them. It also works alone: a run
with only `-f react-query` reports the schedule effects through the
adapter's closure roots.

Recognition fires only on hooks imported from `@tanstack/react-query`
or `react-query`, so a project's own function named `useQuery` is
never taken for the library's.

## What v0 leaves out

- `useQueries` and the `queryOptions` helper.
- Query-key identity: the key is not yet recorded, so two components
  sharing a cache entry are not paired by key.
- RTK Query and SWR, which are different libraries and get their own
  packs.
