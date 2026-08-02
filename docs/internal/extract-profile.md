# Where a cold extract spends its time

Almost all of it is the TypeScript program and the walk suss does
over it. The datalog engine, which used to be half the run on the
React corpora, is now two to three percent.

Numbers below come from `node --cpu-prof` over a `--no-cache`
extract of three public corpora, taken at 6dcc840. Reproduce any
of them with:

```
npm run build
npm run profile twenty-server
node scripts/profile.mjs twenty-front --top 50
```

## The shape

Self time, grouped by which package the sampled frame belongs to.

| package | twenty-server | twenty-front | saleor-dashboard |
| --- | --- | --- | --- |
| ts-morph's bundled compiler | 51.2% | 35.2% | 35.9% |
| ts-morph's node wrappers | 17.4% | 28.8% | 38.8% |
| node runtime, mostly GC and file reads | 20.6% | 20.9% | 13.6% |
| suss adapter | 7.2% | 10.3% | 6.2% |
| suss datalog | 2.4% | 3.8% | 4.4% |
| suss other | 1.2% | 0.8% | 0.8% |

Sampled totals were 18.1s, 37.5s and 22.4s.

Two thirds to three quarters of every run is inside ts-morph. The
two ts-morph rows behave differently, so read them apart.
The bundled compiler row is parsing, binding and type checking:
work suss cannot avoid while it needs a type checker. The wrapper
row is ts-morph's own layer over the compiler AST, and that cost
scales with how often suss walks.

`forEachDescendant` accounts for 49%, 41% and 50% of the three
runs inclusive. Every pass that walks a file pays the wrapper
tax on every node it touches, whether or not it keeps the node.

## What was ours

Four items came back to code suss wrote. All four are fixed.

**Line numbers cost the whole file prefix.** ts-morph's
`getStartLineNumber` counts newlines from position zero on every
call, so a node near the end of a large file costs a scan of
everything above it. suss asks for a line on every terminal,
every effect and every summary location. On saleor-dashboard the
two accessors were 6.1% of self time between them. The compiler
already keeps a cached line-start table on each source file, so
the same answer comes back from a binary search.

**One walk per branch to find one node.** `findBranchSubtree`
walked the whole enclosing function to locate a terminal by line
range, once per branch of that function, computing two line
numbers per node visited. On twenty-front it was 5.9% of the
run. One walk per function answers every branch.

**A directory tree walk per summary.** `locateFunction` called
`project.getSourceFiles()` for each summary it was asked to
place, and ts-morph rebuilds that list by walking directories.
On twenty-front that was 10.3% of the run, inside sub-unit
synthesis. Two other passes had already grown their own fix for
this, so the third now shares it.

**A module's exports recomputed per import site.**
`getExportedDeclarations` walks a file's export symbols and
follows each alias through the type checker, and returns a fresh
map every time. Callee resolution asked the same file the same
question once per import of it: 9.2% of saleor-dashboard.

## What was not ours

**Path canonicalisation.** An earlier profile put about a quarter
of the run in turning file paths into canonical strings. It is
now around 4%, and every caller is inside ts-morph's own file
system host: module resolution, `fileExists`, directory scans
during program creation. No suss frame appears above any of it.
The module graph work took the suss-side repetition out; what is
left is the compiler resolving the module graph once.

**Parse and bind.** `readFileUtf8` alone is 3.5% on twenty-server,
and `createProgram` is 10.2% of twenty-front. That is the cost of
the files the tsconfig names.

## What is left, and what it would take

Ranked by what a fix would return.

**The wrapper tax, roughly a fifth of the run.** ts-morph
allocates a wrapper object per node visited and holds it in a
per-file cache. `forEachChild` builds a snapshot array of
wrappers before it calls back, and `forEachDescendant` allocates
a fresh traversal object per node. Between `getKind` (3.0% to
5.5%), `forEachChild` (2.3% to 2.6%), `nodeCallback` (2.0% to
2.3%), `_getNodeFromCompilerNode` and the compilerNode getter,
plus most of the 10% to 15% in the garbage collector, this is
the largest remaining item. Removing it means walking the
compiler AST directly and wrapping only the nodes a pass keeps.
Every pass in the adapter would be written differently, so
someone should design that before anyone writes it.

**Files held after their facts are read.** Extraction reads a
file, emits its facts, and does not need the AST again. The
compiler's source files cannot be released while the type
checker is alive, and suss needs the checker for the resolution
passes that run after extraction. ts-morph's wrapper cache is
releasable (`forgetNodesCreatedInBlock`), which would cut
retained memory and GC pressure without touching the program.
Whether the passes can be arranged so a file's wrappers are
forgotten before the next file is read is the open question.

**Symbol lookups.** `getSymbolAtLocation` is 12% to 15%
inclusive across the three corpora. Every one of those calls is a
question suss needs the type checker to answer. Whether it asks
the same question twice has not been checked.
