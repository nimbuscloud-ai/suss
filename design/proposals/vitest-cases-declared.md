# vitest's cases through `@suss/recognize`

The TypeScript adapter reads vitest's cases in its own 412-line ts-morph reader. That reader takes every call in the file and asks which runner calls are around it in the syntax tree, so `cases.forEach((c) => it(c.name, ...))` and an `it` in a loop inside a `describe` are cases, titled by the `describe` around them. The `calls` form of the `testCases` member reads the same thing through the ops: it takes `module.calls("file")`, decides which calls are the runner's, and walks up from each one to the runner calls around it. Four ops are new, and the rest are ops every adapter already has.

## The walk up from a call

From a call, the next step up is the call it is an argument of, when the source writes it in place there (`CallOps.passedTo()`, which exists). Otherwise it is the function the call is written in (`CallOps.enclosingBody()`). From a function, the next step is the call it is passed to (`ValueOps.passedTo()`), or else the function it is declared in (`ValueOps.enclosingBody()`). The walk stops at the top of the file. Every runner call it passes is around the call it started from.

| op | what it gives | how the facts say it | Python | Ruby |
|---|---|---|---|---|
| `ValueOps.passedTo()` | the call a value written in place is an argument of, and where | `callArg` or `callKeywordArg` read by the value's column, as `CallOps.passedTo()` reads them for a call | yes: a lambda argument | yes: a lambda argument. A block is no argument, and `blockCall()` gives its call |
| `CallOps.enclosingBody()` | the innermost function, block or class body the call is written in, at any depth inside its expressions, or null at the top of a file | `makesCall` read by the call's column. TypeScript and Python state one row. Ruby states one for each block around the call and one for the method, and the innermost is the one that starts last | yes | yes, by the same rule |
| `ValueOps.enclosingBody()` | the same for a function or a block | a block's call's `enclosingBody()`, through `callBlock`, else `containsFn` read by the function's column | yes | a block, yes. A lambda or a `def` inside a block gets the method, since Ruby states `containsFn` from the method |

All three are read in `@suss/recognize/ops` over facts every adapter states, so they work in the three languages with no adapter code. `callerSite()` reads the same `makesCall` rows, takes only a single row, and gives a key; `enclosingBody()` gives the ops, since the walk asks the function what it is passed to.

## Names a file binds

With vitest's globals on, a runner name counts in a `*.test.*` or `*.spec.*` file unless the file binds the name at its top level. `ModuleOps.bindsAtTopLevel(name)` says that: an import, or a variable, a function or a class declared there. No fact is keyed by file for a declaration that is not exported, so TypeScript reads it off the file's statements, beside `importedNames`, with the helper the hand reader used. Python can state it from a module's assignments, `def`, `class` and imports, and Ruby from a top-level `def`, constant, class or local. Neither does yet, and the reader asks it only for a file `globalsIn` matches, which only vitest declares.

## The callee

The reader works out a call's root name and the modifiers written after it through the ops. A callee written as a name is its root, spelled as `calleeText()`. A method call adds its `method()` as the last modifier, and reads the rest off the receiver: a receiver written as a name (`form()` is `"name"`) is the root, spelled as its `source()`, and a receiver written as a member read is read the same way through `member()`. A call made on a call, `it.each(rows)("t", fn)` or `it.skipIf(c)("t", fn)`, reads the inner call through `callee()`. Its last modifier has to be one of `takingArguments` or `perRow`, and a call written with one of those and nothing after it, `it.each(rows)` alone, is no case. The root counts when `importedNames` maps it to a runner name, or when it is a runner name a globals file does not bind.

## Mocks

The pack states `vi.mock` and `vi.doMock` as `replacesModule` rules and `vi.spyOn` as `replacesMember`, each with `by.from` set to the `returnedBy` origin: the method called on vitest's `vi`, imported from `vitest`, or the global `vi` when the pack has globals on. `mockRead` from the pytest move says what each call replaces. The walk up gives each mock the runner calls around it, and a mock applies to a case when every one of them is the case or a group around it. That is the rule the hand reader applies to the syntax tree. The adapter still turns a relative specifier into a project file (`moduleFileOf`) and a spy's object into the module it imports whole.

## What changes

The vitest pack writes a `testCases` match with a `calls` form, and `TestCaseMatch` goes. The adapter's three special cases read `testCases`: the dispatch, the name gate for `globalsIn`, and the unit with no binding. Two PRs: the four ops with their tests, then the move with the `calls` form, the covered-by-vitest fixture and the byte check inputs.
