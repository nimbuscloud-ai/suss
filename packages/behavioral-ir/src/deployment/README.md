# deployment/

This module works out two things about a set of summaries: which code runs
in each deployable unit, and what values that unit's deployment gives its
variables. `deploymentOf` is the entry point, and the rest of the module
exists to support it.

## Why it lives in the IR package

Three callers need the same result. The behavioural checker pairs a
producer's env-var channel with the resource a template wires it to.
`suss infer intent` writes the name of the store a handler reaches into a
document somebody commits. `checkIntentAgreement` reads that document back
and has to arrive at the same name. Otherwise suss would disagree with a
document it wrote itself.

The two checkers do not depend on each other, on purpose, so a step both
of them take has to live somewhere both can import. For the same reason
`boundaryKey` and `pairingKey` are in `@suss/ir-core` and
`withDeclaredDelivery` is next door here. A join over summaries that more
than one reader needs goes where all of them can reach it.

The step itself, putting a value back into a boundary name, differs per
protocol and lives in `@suss/ir-core`. `groundBinding` calls the protocol's
`groundName`, and `nameReference` returns where a name that is still a
variable points. This module supplies the `Deployment` that those two
query.

## Which variable a reference asks about

A name in the boundary-name syntax can be a reference, such as
`{ORDER_TABLE}` or `{env.SUBSCRIBERS_TABLE}`. `variableAsked` decides which
references are variables that the deployment sets.

- One bare name is a variable. That is how a pack writes a `process.env`
  read.
- A path through the argument that a pack marks as the configuration is a
  variable too, because the runtime fills that argument and no call site
  does. A Worker's `fetch(request, env)` is the example:
  `env.SUBSCRIBERS_TABLE` is a variable.
- A path through any other parameter is for the callers to settle, such as
  `{location.bucket}`. `variableAsked` returns null, and the storage pass
  grounds it from the call sites instead.

## The two channels

- `setTo` is the string the deployment sets a variable to, such as a
  wrangler `[vars]` entry or a SAM `Environment.Variables` value written as
  plain text. When the code addresses a store or a base URL through a
  variable, that string is the store's name or the URL.
- `pointsAt` is the declared resource that the deployment wires a variable
  to, from a template's `!Ref` or `!GetAtt`. A Lambda invoke reaches its
  callee this way. The result is the logical id, because the invoked
  unit's own summary is keyed by the logical id, and the deployed
  function's name would not match it.

Both return null when nothing in the run provides a value, and also when
two deployments of the same code disagree. Picking one of the two would be
a guess, and an unpaired boundary misleads less than a wrong pair.

## Which code runs in a unit

Three sources can answer this. They are listed from the most reliable to
the least.

The summary itself is the best source. A pack that discovers a handler
under a template entry knows which unit the handler will be deployed as,
and records it in `identity.deployableUnit`. When the declaring side and
the code both record which unit they belong to, those two units decide,
and the directory is never consulted.

The next best source is the set of files that the runtime's handler entry
reaches through imports. `entryClosure` walks that graph. Where it finds
the entry, membership decides: a shared helper runs in every runtime whose
closure loads it, and a file outside every closure runs in none.

Either of the last two sources can place a runtime on its own. A Terraform
configuration declares which handler runs but never which directory the
zip was built from, so the entry is the only information available. A
runtime whose entry matches a module is placed by its closure, with no
directory stated. A runtime that matches no module and states no directory
is not placed at all. Leaving it unplaced is better than assigning it the
whole repository.

The template's source directory comes last, and it is used only when it is
the one directory that could contain the file. A monorepo service builds
every function from the service root, so that directory covers all of
them at once and does not show which one runs a given file.
`contestedFiles` lists those files. A caller with that set pairs them
against nothing and reports what it could not decide.

## Key files

- `deployedNames.ts:deploymentOf` builds the `Deployment` that a protocol
  queries, and contains the rule for which variable a reference asks about.
- `deployedValues.ts:deployedValues` reads the values channel. It returns
  every value set by the runtimes that run a unit, and which runtime set
  each one.
- `deployedRefs.ts:deployedRefs` reads the references channel.
- `placement.ts:placeRuntimes` pairs each runtime-config provider with the
  code it runs, and reports the providers that did not declare where their
  code is. `placeDeclared` does the same for one declared summary. A queue
  consumer states the same code scope as the function it runs on, so this
  places it by its handler entry the same way as that function.
- `unitScope.ts:runsIn` is the predicate that the pairing passes call. It
  compares the directory path directly and does not use a separate test,
  so two passes cannot disagree about what counts as inside.
  `fileInCodeScope` in `@suss/ir-core` does that comparison and stops at a
  segment boundary, so `src/foo` never matches `src/foobar`.
- `unitScope.ts:unitsByFile` groups the units in a summary set by file, and
  keeps every unit that a file's summaries mention. A module with two
  handlers in it is deployed as both, so its helpers run in each one.
