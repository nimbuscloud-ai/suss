# scope/

This module answers "which code runs in this deployable unit" for the pairing
passes that compare a declared unit against the code deployed inside it.

## Why it exists

Two passes need the answer. `runtime-config/` pairs a Lambda's declared
environment against the `process.env` reads in its code. `message-bus/` pairs
a queue subscription against the receive sites in its consumer. Both of them
resolve a producer's env-var channel through the environment of the runtime it
was deployed with.

Both of them used to go by the file path. A template gives a source directory,
and a monorepo service builds every one of its functions from the service
root, so one directory covers all of them at once. Every function's code then
paired against every other function's contract.

## The rule

A pack that discovers a handler under a template entry knows the unit it will be
deployed as, and stamps `identity.deployableUnit`. Where the declaring side and
the code both say which unit they belong to, the two units decide, and nothing
consults the directory.

Where either side says none, the directory decides, and only where a single
directory could. A service that builds every one of its functions from the
service root gives them all the same directory, so a shared helper is inside
every unit at once and the directory says nothing about which one runs it.
`contestedFiles` lists those files, and a caller that has that set pairs them
against nothing and reports what it could not tell.

## Key files

- `unitScope.ts:runsIn` is the predicate both passes call. It takes a
  `UnitScope` with the declaring side's unit and its directory fallback in it.
  The directory is the path itself rather than a test over it, so the two
  passes cannot disagree about what counts as inside. `fileInCodeScope` in
  `@suss/ir-core` owns that comparison, and it stops at a segment boundary,
  so a scope of `src/foo` never reaches `src/foobar`.
- `unitScope.ts:unitsByFile` reads the units off a summary set and groups them
  by file, keeping every unit a file's summaries mention. A module with two
  handlers in it is deployed as both, so its helpers run in each one.
- `unitScope.ts:contestedFiles` gives you the files that two or more scopes'
  directories contain, among code that does not say which unit it belongs to.
- `unitScope.ts:sameUnit` compares two units on deployment target and instance
  name.
