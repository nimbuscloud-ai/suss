# @suss/framework-zustand

The PatternPack for zustand stores.

A store is client-side state with readers and writers the way a table
has them, so its accesses come out as `storage-access` effects against
`client-store:<name>`:

```ts
useAppStore.setState({ bears: 5 })   // write of fields [bears]
useAppStore.getState().bears         // read
```

`ask "what writes client-store:useAppStore"` then reads like the same
question about a database, and the checker's storage pass compares the
two sides. The client is anything built from zustand's `create` (or
`zustand/vanilla`'s), and the store's variable name is the container,
since that is what the project calls the store.

## Usage

```bash
suss extract -f react -f zustand -p tsconfig.json
```

## What v0 leaves out

- The hook's selector form (`useAppStore((s) => s.bears)`), which is a
  bare call of the store rather than a method on it. The recognize
  links it needs are written up in the pack's issue, and selector
  reads land when they do.
- The curried creator (`create<T>()(init)`), which the client origin
  does not follow yet.
- A functional `setState((s) => ({...}))` states its fields in the
  lambda's return, so such a write comes out with no fields rather
  than wrong ones.
