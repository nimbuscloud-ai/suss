# Proposal: frontend discovery modes and React root-walk

Status: draft, seeking alignment. No implementation yet. Revised
2026-08-28: the root-walk section now targets the reachable closure
the adapter has since grown, instead of a new project-scoped walker.

## The problem, by example

The React pack finds components by looking at exports. Given a file:

```tsx
export const UserCard = ({ user }) => <div>{user.name}</div>;

function Avatar({ src }) {          // not exported
  return <img src={src} />;
}

export default function Page() {
  return <UserCard user={u} />;     // renders UserCard, and Avatar somewhere
}
```

Today's discovery finds `UserCard` and `Page` (both exported, PascalCase,
JSX-returning) and misses `Avatar` (never exported). It also learns
nothing about who renders whom: `UserCard`, `Avatar`, and `Page` come
out as three unrelated units, even though the whole point of a component
boundary is that `Page` passes props into `UserCard` and `UserCard` may
read props `Page` never passes.

Export-based discovery answers "which functions look like components".
It cannot answer "what does this app render, and how do components pass
data to each other". The second question is the React cross-boundary
story, and it needs a different discovery strategy.

## Two strategies, and why we want both

**Export heuristic (shipped).** It takes every export whose body returns
JSX and whose name is PascalCase, and it skips story and test files. It
is cheap and syntactic, and it needs no entry point. It catches most
components in a production codebase. It is blind to non-exported
components and to the render tree.

**Root-walk (this proposal).** Start from where the app boots and follow
what it renders:

- Find a render root: `createRoot(el).render(<App/>)`, `ReactDOM.render`,
  `hydrateRoot`, or a route element (`<Route element={<Users/>}>`).
- Read the root component's JSX for the child components it references.
- Resolve each reference to its declaration (local, imported, or a
  variable that contains a component), emit it as a unit, and record the
  parent -> child render edge.
- Recurse into each resolved child.

Root-walk catches non-exported components, and it produces the render
edges that let the checker compare props a parent passes against props a
child reads. It also visits only reachable code instead of every file's
exports, so on a large app it does less work, not more.

Neither strategy dominates. The export heuristic finds a component
library's exports that no local root renders. Root-walk finds the
wired-up tree and the non-exported pieces. A production app wants both, deduplicated.

## The design: discovery modes as a composable list

The React pack already has two discovery mechanisms side by side: a
data-driven `discovery: [namedExport(["default"])]` entry and a
`discoverUnits` callback (`reactComponentExports`). They are two modes in
all but name. Give them names, add a third, and make the set a list a
pack composes:

```
discovery modes (per pack):
  - default-export      (the data-driven namedExport entry, today)
  - export-heuristic    (the reactComponentExports callback, today)
  - root-walk           (new)
```

Each mode is a function from a source file (or a project, for root-walk)
to discovered units. The adapter runs the pack's modes, unions the
results, and deduplicates by declaration identity (the same function node
discovered twice is one unit). A unit's render edges, when a mode
produces them, attach to the summary regardless of which mode found the
unit. The refactor is behavior-preserving: React's mode list is
`[default-export, export-heuristic]` before root-walk lands.

This matters beyond React. Vue, Svelte, and Solid have the same
export-vs-root tension. A pack author should compose the modes their
framework needs instead of inheriting one baked-in arrangement. The
React pack becomes `[default-export, export-heuristic, root-walk]`, and
a stricter pack could be `[root-walk]` alone.

The dedup key is declaration identity, not name, so a component found by
both the heuristic (because it is exported) and the walk (because a root
renders it) collapses to one unit that has the render edges from the
walk.

## The walk already exists

When the draft above was written, root-walk needed a new project-scoped
pass, and open question 1 asked how the adapter would schedule one. The
adapter has since grown exactly that pass for another reason: the
reachable closure (`resolve/reachableClosure.ts`) walks the call graph
from seed functions, project-wide, over shared datalog `entry` /
`calls` / `reachable` facts, and it took an `extraRoots` seam so a
recognizer-only pack's exports could feed it (#647).

Root-walk should be this closure with two additions, never a second
walker:

- **Roots feed `extraRoots`.** A pack-declared root pattern
  (`createRoot(el).render(<App/>)`, `hydrateRoot`, a route element)
  resolves the rendered component reference and hands that declaration
  to the closure as a root, through the same seam
  `recognizerOnlyRoots` uses today. Module-scope boot calls are not
  units, and the seam exists because roots that are not units already
  needed a way in.
- **JSX references are edges.** The closure's edge extraction reads
  call expressions today. A `<UserCard .../>` opening element is the
  same kind of edge with a props expression on it: identifier, resolve
  to declaration, record the edge fact. The resolution cases (local
  function, imported binding, const bound to a component) are the ones
  the closure and `subjects.ts` already resolve for calls.

This answers open question 1: the closure already runs after per-file
discovery, project-scoped, so the mode list only distinguishes
file-scoped modes from "seeds for the closure", and the adapter
schedules nothing new. It also shrinks step 2 of the build order from
"build the walk" to "teach the walk JSX edges and root seeds".

## What root-walk needs from the adapter

- **Root recognition.** A small set of patterns for the boot calls and
  route elements. These are pack-declared (React knows `createRoot`;
  Vue knows `createApp(...).mount`), so the vocabulary stays in the
  pack, not the adapter. The adapter provides the JSX-reference walk and
  the reference resolution, and the pack says what a root looks like.
- **Reference resolution.** Given a JSX element `<UserCard .../>`,
  resolve `UserCard` to its declaration. Three cases: a local function,
  an imported binding (follow the import), and a variable bound to a
  component (the adapter's existing binding resolution, `subjects.ts`).
  A reference that resolves to none of these is recorded as an unresolved
  render edge with a reason, never dropped.
- **Render edges.** For each child it renders, the parent unit gains an
  edge with the child's identity and the props expression passed at the
  call site on it. That edge is where the props-passed side of the
  comparison gets its data. The render tree IR (`Output.render.root`)
  already models the JSX structure, and the edge adds the resolved
  target identity to each child element that is a component rather than
  a host tag.

## What it unlocks, in build order

1. **Discovery-mode composition** in the pack interface. Refactor the
   two existing React discovery paths into named modes behind one list.
   No behavior change, and this is the seam root-walk plugs into.
2. **Root recognition and the reference walk.** Emit non-exported
   components reachable from a root. We measure this against an actual
   app: how many components does root-walk add over the heuristic, and
   how many references go unresolved.
3. **Render edges with resolved targets.** Attach parent -> child
   identity and the props expression. This renders the tree in inspect
   with actual component names instead of bare element tags.
4. **Props checking across the render edge.** Shipped through step 3
   (2026-08-28): JSX references are closure edges, and an element whose
   tag resolves records the declaration's file and name as `target`, so
   the parent's attrs and the child's summary join. The check itself
   has to clear the bar the story check set: TypeScript already rejects
   a missing required prop and an unknown extra one at compile time, so
   findings there are noise. What TypeScript does not give:
   a prop the child declares and never reads (a dead contract field,
   which needs prop-read collection, the `collectClientFieldAccesses`
   analog); a pair whose two sides were extracted separately, the way a
   design-system package is consumed from another repo; and the
   form-to-API hop, where the attrs on a form element meet an HTTP
   contract rather than a component. Those three are the build order
   within this step.

   The original sketch: A new checker pass: the
   props a parent passes vs the props the child reads. The child summary
   already has a `props` parameter input, and prop references
   (`props.name`) are scattered through its conditions and render tree.
   Collecting those into the set of props the child actually consumes is
   part of this step, the same kind of work `collectClientFieldAccesses`
   does for HTTP consumers. This is the React analogue of
   provider/consumer status coverage, and it is the reason root-walk is
   worth building.

Steps 1 through 3 are discovery and IR. Step 4 is the payoff and can
follow once edges are reliable.

## Guardrails

- **Modes compose, they do not replace.** Adding root-walk must not drop
  a component the export heuristic finds. The union-and-dedup is the
  contract.
- **Unresolved is a value.** A JSX reference the walk cannot resolve
  (dynamic component, HOC, a component chosen by a runtime map) becomes
  an unresolved render edge with a reason. The tree says where it stopped
  seeing, and it never silently prunes a branch.
- **Root vocabulary stays in the pack.** The adapter walks and resolves.
  What counts as a render root is React's knowledge, expressed as
  pack-declared patterns, so a framework's death takes only its pack.
- **No new authoring surface.** Discovery is extraction. Users write no
  markers to be found.

## Beyond discovery: the joins that make the tree worth having

The render tree and props checking are one of the questions a frontend
team would ask of this tool. Walking the rest of the question space
surfaced four more, each a join from the render tree to a boundary suss
already reads. Agreed 2026-08-28, in this order.

**1. Data-fetching hooks (build first).** The client packs read raw
`fetch`, axios, and Apollo, but production React apps mostly reach
APIs through React Query, SWR, or RTK Query. A component calling
`useQuery({ queryKey: ["orders"], queryFn: fetchOrders })` never shows
up as a consumer today, so "which component reads GET /orders" comes
back empty on the apps most teams have. The HTTP call itself lives in
the query function and the fetch pack already reads it; what is
missing is the attribution of that call to the component through the
hook. The hook is pack-declared scheduling: the pack says `queryFn`
runs, and the walk carries the component through it. Per-library
config over existing primitives, the same conclusion the GraphQL
client work reached.

**2. Next.js server actions.** A `"use server"` function called from a
button is an RPC crossing with no visible HTTP: the types make it look
like a local call, and nothing in the file says what it writes. The
nextjs pack reads route handlers and pages but not actions. The most
suss-shaped gap of the four, a boundary crossing the source hides, and
App Router apps are where new frontend code is written.

**3. Client state stores.** "What reads this Zustand or Redux slice"
is the reads/writes question suss already answers for DynamoDB,
applied to a store. The access-tracing direction treats storage as a
protocol family; a client store is another member, and the render tree
makes the answers navigable by component.

**4. Form-to-API field checking.** The fields a form submits against
the fields the endpoint reads: a provider/consumer pair joining the
render IR to the HTTP contracts that already exist. The cheapest
striking demo ("this form submits `phone` and the API drops it"), and
it waits only on render edges.

The thread through all four: frontend value is the join from UI to the
boundaries suss already reads, extending the flow story one hop into
the browser. Stores and forms follow once render edges land.

## Open questions for alignment

1. Is root-walk a per-file pass or a per-project pass? Roots can render
   components from anywhere, so the walk is naturally project-scoped,
   which breaks the current per-file discovery assumption. Proposal:
   root-walk is a project-scoped mode, and the mode list tells
   file-scoped modes from project-scoped ones so the adapter schedules
   each correctly. This is the largest structural question.
2. How are Storybook stories treated? A story is a sub-tree root
   (`export const Primary = () => <Button primary/>`). Proposal: the
   Storybook contract source already covers stories as declared render
   contracts. Root-walk should not also treat them as app roots, so
   story files stay excluded from root recognition.
3. Do render edges belong on the parent summary or as separate pairing
   records like boundary bindings? Proposal: on the parent, as part of
   its render output, since a render edge is behavior of the parent.
   The checker joins parent edges to child summaries by identity, the
   same way as the existing consumer/provider join.
4. How much reference resolution is in scope for v1? Local plus
   single-hop import plus single const binding covers the common case.
   HOCs, component maps, and `React.lazy` are the unresolved tail.
   Proposal: v1 resolves the three common cases, records the tail as
   unresolved edges, and revisits once production-app numbers show which tail
   cases are worth chasing.
