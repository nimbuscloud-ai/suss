# @suss/framework-zustand

The pack for zustand stores.

A store is client-side state with readers and writers, the same way a
table has them. So the pack records each access as a `storage-access`
effect against `client-store:<name>`:

```ts
useAppStore.setState({ bears: 5 })    // write of fields [bears]
useAppStore.getState().bears          // read
useAppStore((s) => s.bears)           // read of fields [bears]
```

That means `ask "what writes client-store:useAppStore"` works the way
the same question about a database does, and the checker's storage
pass compares the two sides. The client is anything built from
zustand's `create`, or from `zustand/vanilla`'s. The container is the
store's variable name, since that is what the project calls the store.

## Usage

```bash
suss extract -f react -f zustand -p tsconfig.json
```

The hook's selector form matches as a bare call of the store, and the
fields it reads come from the selector's parameter: `(s) => s.bears`
reads `bears`, and `(s) => s` reads everything.

## What this leaves out

- The curried creator (`create<T>()(init)`), which suss does not follow
  back to a client yet.
- A functional `setState((s) => ({...}))`, whose fields are in the
  lambda's return value. Such a write comes out with no fields, so at
  least it never lists the wrong ones.
