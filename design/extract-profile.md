# Where a cold extract spends its time

Almost all of it goes to the TypeScript program and the walk suss does
over it. The datalog engine used to take half the run on the React
corpora, and now it takes two to three percent.

The numbers below come from `node --cpu-prof` over a `--no-cache`
extract of three public corpora, taken at 6dcc840. You can reproduce
any of them with:

```
npm run build
npm run profile twenty-server
node scripts/profile.mjs twenty-front --top 50
```

## The shape

This is self time, grouped by the package the sampled frame belongs to.

| package | twenty-server | twenty-front | saleor-dashboard |
| --- | --- | --- | --- |
| ts-morph's bundled compiler | 51.2% | 35.2% | 35.9% |
| ts-morph's node wrappers | 17.4% | 28.8% | 38.8% |
| node runtime, mostly GC and file reads | 20.6% | 20.9% | 13.6% |
| suss adapter | 7.2% | 10.3% | 6.2% |
| suss datalog | 2.4% | 3.8% | 4.4% |
| suss other | 1.2% | 0.8% | 0.8% |

The sampled totals were 18.1s, 37.5s and 22.4s.

Between two thirds and three quarters of every run is spent inside
ts-morph. The two ts-morph rows behave differently, so read them
separately. The bundled compiler row is parsing, binding and type
checking, which suss cannot avoid while it needs a type checker. The
wrapper row is ts-morph's own layer over the compiler AST, and its
cost grows with how often suss walks the tree.

Including callees, `forEachDescendant` accounts for 49%, 41% and 50%
of the three runs. Every pass that walks a file pays the wrapper cost
on every node it touches, whether it keeps the node or not.

## What was ours

Four of the costs came from code suss wrote. All four are fixed.

**Line numbers cost a scan of everything above the node.** ts-morph's
`getStartLineNumber` counts newlines from position zero on every call,
so a node near the end of a large file costs a scan of everything
before it. suss asks for a line number on every terminal, every effect
and every summary location. On saleor-dashboard the two accessors
took 6.1% of self time between them. The compiler already keeps a
cached table of line starts on each source file, so a binary search
over it now returns the same number.

**One walk per branch to find one node.** `findBranchSubtree` walked
the whole enclosing function to find a terminal by its line range. It
did this once for each branch of the function, and computed two line
numbers for every node it visited. On twenty-front it took 5.9% of the
run. Now one walk per function covers every branch.

**A directory tree walk per summary.** `locateFunction` called
`project.getSourceFiles()` for every summary it had to place, and
ts-morph rebuilds that list by walking directories. On twenty-front
that was 10.3% of the run, inside sub-unit synthesis. Two other passes
had already built their own fix for this, and the third now shares it.

**A module's exports recomputed for each import.**
`getExportedDeclarations` walks a file's export symbols, follows each
alias through the type checker, and returns a new map every time.
Callee resolution asked the same file the same question once for each
import of it, which cost 9.2% of saleor-dashboard.

## What was not ours

**Path canonicalisation.** An earlier profile showed about a quarter
of the run turning file paths into canonical strings. It is now around
4%, and every caller is inside ts-morph's own file system host: module
resolution, `fileExists`, and directory scans while the program is
created. No suss frame appears above any of it. The module graph work
removed the repeated calls on the suss side, and what is left is the
compiler resolving the module graph once.

**Parse and bind.** `readFileUtf8` alone takes 3.5% on twenty-server,
and `createProgram` takes 10.2% of twenty-front. That is the cost of
reading the files the tsconfig lists.

## What is left, and what it would take

These are ranked by how much a fix would save.

**The wrapper cost, roughly a fifth of the run.** ts-morph allocates a
wrapper object for each node visited and keeps it in a per-file cache.
`forEachChild` builds a snapshot array of wrappers before it calls
back, and `forEachDescendant` allocates a new traversal object for
each node. This is the largest item left. It covers `getKind` (3.0% to
5.5%), `forEachChild` (2.3% to 2.6%), `nodeCallback` (2.0% to 2.3%),
`_getNodeFromCompilerNode` and the compilerNode getter, plus most of
the 10% to 15% spent in the garbage collector. Removing it means
walking the compiler AST directly and wrapping only the nodes a pass
keeps. Every pass in the adapter would have to be written differently,
so someone should design that change before anyone writes it.

**Files kept in memory after their facts are read.** Extraction reads
a file, emits its facts, and does not need the AST again. The
compiler's source files cannot be released while the type checker is
alive, and suss needs the checker for the resolution passes that run
after extraction. ts-morph's wrapper cache can be released
(`forgetNodesCreatedInBlock`), which would cut retained memory and GC
pressure without touching the program. The open question is whether
we can order the passes so that a file's wrappers are released before
the next file is read.

**Symbol lookups.** `getSymbolAtLocation` takes 12% to 15% of each run
across the three corpora, including callees. suss needs the type
checker for every one of those calls. Nobody has checked whether it
asks the same question twice.
