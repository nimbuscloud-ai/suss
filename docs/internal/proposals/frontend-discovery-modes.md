# Proposal: frontend discovery modes and React root-walk

Status: draft, seeking alignment. No implementation yet.

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

**Export heuristic (shipped).** Every export whose body returns JSX,
PascalCase, skipping story and test files. Cheap, syntactic, no entry
point needed. Catches most components in a real codebase. Blind to
non-exported components and to the render tree.

**Root-walk (this proposal).** Start from where the app boots and follow
what it renders:

- Find a render root: `createRoot(el).render(<App/>)`, `ReactDOM.render`,
  `hydrateRoot`, or a route element (`<Route element={<Users/>}>`).
- Read the root component's JSX for the child components it references.
- Resolve each reference to its declaration (local, imported, or a
  variable holding a component), emit it as a unit, and record the
  parent -> child render edge.
- Recurse into each resolved child.

Root-walk catches non-exported components, and it produces the render
edges that let the checker compare props a parent passes against props a
child reads. It also visits only reachable code instead of every file's
exports, so on a large app it does less work, not more.

Neither strategy dominates. Export heuristic finds a component library's
exports that no local root renders. Root-walk finds the wired-up tree and
the non-exported pieces. A production app wants both, deduplicated.

## The design: discovery modes as a composable list

The React pack already carries two discovery mechanisms side by side: a
data-driven `discovery: [namedExport(["default"])]` entry and a
`discoverUnits` callback (`reactComponentExports`). They are two modes in
all but name. This proposal names them, adds a third, and makes the set a
list a pack composes:

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
framework needs instead of inheriting one baked-in shape. The React pack
becomes `[default-export, export-heuristic, root-walk]`; a stricter pack
could be `[root-walk]` alone.

The dedup key is declaration identity, not name, so a component found by
both the heuristic (because it is exported) and the walk (because a root
renders it) collapses to one unit that carries the render edges from the
walk.

## What root-walk needs from the adapter

- **Root recognition.** A small set of patterns for the boot calls and
  route elements. These are pack-declared (React knows `createRoot`;
  Vue knows `createApp(...).mount`), so the vocabulary stays in the
  pack, not the adapter. The adapter provides the JSX-reference walk and
  the reference resolution; the pack says what a root looks like.
- **Reference resolution.** Given a JSX element `<UserCard .../>`,
  resolve `UserCard` to its declaration. Three cases: a local function,
  an imported binding (follow the import), and a variable bound to a
  component (the adapter's existing binding resolution, `subjects.ts`).
  A reference that resolves to none of these is recorded as an unresolved
  render edge with a reason, never dropped.
- **Render edges.** The parent unit gains, per rendered child, an edge
  carrying the child's identity and the props expression passed at the
  call site. This is where the props-passed side of the comparison reads
  from. The render tree IR (`Output.render.root`) already models the JSX
  structure; the edge adds the resolved target identity to each child
  element that is a component rather than a host tag.

## What it unlocks, in build order

1. **Discovery-mode composition** in the pack interface. Refactor the
   two existing React discovery paths into named modes behind one list.
   No behavior change; this is the seam root-walk plugs into.
2. **Root recognition and the reference walk.** Emit non-exported
   components reachable from a root. Measured against a real app: how
   many components does root-walk add over the heuristic, and how many
   references go unresolved.
3. **Render edges with resolved targets.** Attach parent -> child
   identity and the props expression. Renders the tree in inspect with
   real component names instead of bare element tags.
4. **Props checking across the render edge.** A new checker pass: the
   props a parent passes vs the props the child reads. The child summary
   already carries a `props` parameter input and prop references
   (`props.name`) scattered through its conditions and render tree;
   collecting those into the set of props the child actually consumes is
   part of this step, the same shape of work `collectClientFieldAccesses`
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
  seeing; it never silently prunes a branch.
- **Root vocabulary stays in the pack.** The adapter walks and resolves.
  What counts as a render root is React's knowledge, expressed as
  pack-declared patterns, so a framework's death takes only its pack.
- **No new authoring surface.** Discovery is extraction. Users write no
  markers to be found.

## Open questions for alignment

1. Is root-walk a per-file pass or a per-project pass? Roots can render
   components from anywhere, so the walk is naturally project-scoped,
   which breaks the current per-file discovery assumption. Proposal:
   root-walk is a project-scoped mode; the mode list distinguishes
   file-scoped from project-scoped modes so the adapter schedules each
   correctly. This is the largest structural question.
2. How are Storybook stories treated? A story is a sub-tree root
   (`export const Primary = () => <Button primary/>`). Proposal: the
   Storybook contract source already covers stories as declared render
   contracts; root-walk should not also treat them as app roots, so
   story files stay excluded from root recognition.
3. Do render edges belong on the parent summary or as separate pairing
   records like boundary bindings? Proposal: on the parent, as part of
   its render output, since a render edge is behavior of the parent.
   The checker joins parent edges to child summaries by identity, the
   same shape as the existing consumer/provider join.
4. How much reference resolution is in scope for v1? Local plus
   single-hop import plus single const binding covers the common case.
   HOCs, component maps, and `React.lazy` are the unresolved tail.
   Proposal: v1 resolves the three common cases, records the tail as
   unresolved edges, and revisits once real-app numbers show which tail
   cases are worth chasing.
