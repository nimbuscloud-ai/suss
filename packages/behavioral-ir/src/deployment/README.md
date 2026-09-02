# deployment/

This module settles two questions about a set of summaries: which code runs in
each deployable unit, and what that unit's deployment fills its variables in
with. `deploymentOf` is the entry point, and everything else here is what it
needs to get there.

## Why it lives in the IR package

Three callers need the same result. The behavioural checker pairs a producer's
env-var channel against the resource a template wires it to. `suss infer intent`
writes the name of the store a handler reaches into a document somebody commits.
`checkIntentAgreement` reads that document back and has to arrive at the same
name, or a document suss wrote would be one suss then argued with.

The two checkers deliberately do not depend on each other, so a step both of
them take belongs under both. That is the same reason `boundaryKey` and
`pairingKey` are in `@suss/ir-core` and `withDeclaredDelivery` is next door
here: a join over summaries that more than one reader takes goes where all of
them can reach it, not inside one of them.

The step itself, putting a value back into a boundary name, is per protocol and
lives in `@suss/ir-core`: `groundBinding` calls the protocol's `groundName`,
and `nameReference` says where a name that is still a variable points. This
module supplies the `Deployment` those two ask.

## Which variable a reference asks about

A name in the boundary-name syntax can be a reference: `{ORDER_TABLE}`,
`{env.SUBSCRIBERS_TABLE}`, `{location.bucket}`. `variableAsked` decides which
of those is a variable the deployment sets.

- One bare name is a variable. That is how a pack spells a `process.env` read.
- A path through the argument a pack calls the configuration is one too, because
  what fills that argument is the runtime rather than any call site. A Worker's
  `fetch(request, env)` is the case: `env.SUBSCRIBERS_TABLE` is a variable.
- A path through any other parameter is a caller's to settle, so this returns
  null and the storage pass grounds it from the call sites instead.

## The two channels

- `setTo` is the string the deployment sets a variable to: a wrangler `[vars]`
  entry, a SAM `Environment.Variables` value written as plain text. A store or
  a base URL the code addresses through a variable is that string.
- `pointsAt` is the declared resource the deployment wires a variable to, from a
  template's `!Ref` or `!GetAtt`. A Lambda invoke reaches its callee this way,
  and the logical id is the answer rather than the deployed function's name,
  because the invoked unit's own summary is keyed by the logical id.

Both return null when nothing in the run says, and when two deployments of the
same code disagree. Picking one of the two would be a guess, and an unpaired
boundary says less than a wrong pair.

## Which code runs in a unit

Three things can tell you, in descending order of how much they know.

Best is the summary itself. A pack that discovers a handler under a template
entry knows which unit it will be deployed as, and stamps
`identity.deployableUnit`. Where the declaring side and the code both say which
unit they belong to, the two units decide and nothing consults the directory.

Next best are the files the runtime's handler entry reaches through imports.
`entryClosure` walks that graph, and where it finds the entry, membership
decides: a shared helper runs in every runtime whose closure loads it, and a
file outside every closure runs in none.

Last comes the template's source directory, and only when it is the one
directory that could contain the file. A monorepo service builds every function
from the service root, so that directory covers all of them at once and says
nothing about which one runs a given file. `contestedFiles` lists those, and a
caller that has that set pairs them against nothing and reports what it could
not tell.

## Key files

- `deployedNames.ts:deploymentOf` builds the `Deployment` a protocol asks, and
  owns the rule for which variable a reference asks about.
- `deployedValues.ts:deployedValues` reads the values channel, with every value
  the runtimes running a unit set, and the runtime that set each one.
- `deployedRefs.ts:deployedRefs` reads the references channel.
- `placement.ts:placeRuntimes` pairs each runtime-config provider with the code
  it runs, and reports the ones that said nothing about where their code is.
- `unitScope.ts:runsIn` is the predicate the pairing passes call. The directory
  is the path itself rather than a test over it, so two passes cannot disagree
  about what counts as inside; `fileInCodeScope` in `@suss/ir-core` owns that
  comparison and stops at a segment boundary, so `src/foo` never reaches
  `src/foobar`.
- `unitScope.ts:unitsByFile` groups the units off a summary set by file, keeping
  every unit a file's summaries mention. A module with two handlers in it is
  deployed as both, so its helpers run in each one.
