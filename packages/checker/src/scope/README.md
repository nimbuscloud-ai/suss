# scope/

Answers "which code runs in this deployable unit" for the pairing passes that
compare a declared unit against the code deployed inside it.

## Why it exists

Two passes need the answer. `runtime-config/` pairs a Lambda's declared
environment against the `process.env` reads in its code, and `message-bus/`
pairs a queue subscription against the receive sites in its consumer, and both
resolve a producer's env-var channel through the environment of the runtime it
was deployed with.

Both used to ask the file path. A template names a source directory, and a
monorepo service builds every one of its functions from the service root, so
the directory answers for all of them at once. Every function's code then paired
against every other function's contract.

## The rule

A pack that discovers a handler under a template entry knows the unit it will be
deployed as, and stamps `identity.deployableUnit`. Where the declaring side and
the code both name a unit, the two units decide, and the directory is not
consulted. Where either side names none, the directory answers as before, so a
pack that never stamps the field keeps pairing exactly as it did.

## Key files

- `unitScope.ts:runsIn` is the predicate both passes call. It takes a
  `UnitScope` carrying the declaring side's unit and its directory fallback.
- `unitScope.ts:unitsByFile` reads the units off a summary set and groups them
  by file, dropping any file whose summaries disagree.
- `unitScope.ts:sameUnit` compares two units on deployment target and instance
  name.
