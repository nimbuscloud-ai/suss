# Where the same thing is written twice

Three copies of `normalizeCodeUri` disagreed about a trailing slash. One
appended it, one kept whatever the template wrote, one stripped it. The
checker prefix-matches the field they produce against summary file
paths, and the checker read it two ways as well: `startsWith` in one
place and `includes` in another. That was four spellings of one
convention, on a field that decides which Lambda a finding points at.
#78 fixed it while this was being written.

We went looking for the rest of that pattern across every package.
Forty-six clusters are written up below, and we merged eight of them in
this change. We ranked them by evidence: a copy that already disagrees
ranks above a copy that merely exists, and a disagreement that reaches
output ranks above one its callers absorb.

We give the counts from the public corpora in full. For a run against a
production monorepo we give only a ratio, which says nothing about how
that codebase is put together.

## Two things decide the ranking

**Do the copies already disagree?** Where they agree, merging is
arithmetic and the only question is where the surviving copy should go.
Where they disagree, merging means choosing, and something changes. We
separate the two below because they are different kinds of work, not
different sizes of the same work.

**Does the disagreement reach output?** `makeSide` differs between two
files on whether it writes out an empty transition id, and no caller
passes an empty transition id, so nothing you can observe changes.
`refTarget` differs on whether `Fn::GetAtt` resolves, and the spelling
it drops is the one AWS's own documentation uses. Both are two copies
that disagree. Only one is a bug.

A third thing shaped the survey more than we expected. The largest
single duplication in the repo is not in the product code. Thirty-one
test files construct a ts-morph `Project`, thirty-eight times, and they
do not agree: `target` is 99 in most, 9 in two, `ScriptTarget.ES2022` in
five; `jsx` is 4 in three and 2 in one; `moduleResolution` is missing in
about half. Eleven of those construct the adapter afterwards in a
function called `runAdapter`, and four of those eleven are
byte-identical once you substitute the pack name. Two packs go further
and hand-roll their own `extractArgs`, so the unit tests for aws-sqs and
aws-eventbridge each run against a different and incorrect model of the
input those packs get in production. Neither test double inlines a
module-level `const` the way the adapter does, which is why the
`process.env` disagreement in the next section survived.

## Group one: copies that agree

We implemented these in this change. Every one is byte-identical or
provably equivalent, so no output changes. We verified that: the
summaries came out byte-identical on twenty-front, saleor-dashboard,
saleor-storefront and directus/api.

| what | sites | where it moved to |
|---|---|---|
| the `file::name` string a finding uses to identify a summary | 19 | `summaryRef` in `@suss/behavioral-ir` |
| `dispatchByType` + `DispatchTable` | 3 | `@suss/ir-core` |
| `unwrapBodyField` | 2 | the checker's declared-contract module |
| `isSuccessStatus`, counting three inline copies of the range | 5 | the checker's response-match module |
| `unwrapInitializer` and `unwrap`, byte-identical | 2 | `peelSyntax` in the adapter's walk module |
| `unwrapParens` | 2 | `peelParens`, same module |
| `isAncestorOrSelf` | 2 | the adapter's conditions module |
| a status fold that re-implemented two helpers its own file already imports | 1 | calls the imports |

Two of these deserve more than a table row.

**The summary reference.** Somebody wrote out
`${location.file}::${identity.name}` at 19 places across three packages.
Every copy agreed, so nothing was broken, but something also parses the
string rather than only printing it: the checker deduplicates findings
by it, and a `.sussignore` rule matches against it. Nineteen authors of
a wire format is how a twentieth ends up picking a different separator.
It now has one constructor.

**The dispatch table.** Three byte-identical copies, one of which
somebody had already pulled out into its own file in the fuzzer, citing
the style decision in its header. The idiom is a rule for the whole
repo, so it belongs in the package that owns primitives for the whole
repo rather than in three packages that each rediscovered it.

**The peelers.** `unwrapInitializer` in the resolution pass had a
docstring saying it must mirror the shape pass's `unwrap` except that it
does not peel `await`. The shape pass's `unwrap` does not peel `await`
either, and says so four lines further down. The bodies were identical,
so the comment describing the difference was describing nothing. The two
now share `peelSyntax`. That closes 2 of the 29 sites that peel
wrappers. The other 27 disagree with each other, so they are item 9
below.

One thing fell out of this by accident. Adding a value import to
`interpret.ts` put it in the module graph for the first time, and suss
now sees 7 units inside it that it could not see before. suss does not
walk a module that only a type-only import reaches. That gap is worth
its own look.

## Group two: copies that disagree

We did not implement these. Each one needs a decision about which
behaviour is right, and each one changes output.

### 1. `refTarget` drops `Fn::GetAtt`, and SQS consumers vanish

Six functions across two packages work out which logical id a value
points at, and they do it four different ways. The one that handles `AWS::Lambda::EventSourceMapping.FunctionName` handles
`Ref` and a bare string, and returns null for `Fn::GetAtt`.
`FunctionName: !GetAtt OrdersWorker.Arn` is the spelling AWS documents,
because the property takes an ARN.

We measured this on a four-resource template, changing only that one
line:

```
FunctionName: !Ref OrdersWorker        3 summaries, consumer present
FunctionName: !GetAtt OrdersWorker.Arn 2 summaries, consumer gone
```

The `OrdersWorker.EventSourceMapping` consumer summary is what tells the
checker which Lambda reads the queue. Without it, nothing looks like it
consumes the queue.

Twenty lines above the broken copy, the EventBridge path uses a version
that does unwrap `Fn::GetAtt`, and its docstring points out the
difference: "Unlike the local `refTarget` used by the SQS paths, this
also unwraps `Fn::GetAtt`". Somebody noticed the difference, wrote it
down, and left it there. The EventBridge behaviour is right, and the SQS
path should use it too. For every input the broken copy accepts, the
working copy gives the same result, so there is no question about which
way to merge.

One of the six has to keep behaving differently. The env-var reader
rejects a bare string on purpose, because a plain string env-var value
is data rather than wiring, and resolving it would invent a reference.
That exception has to survive the merge.

It costs little to fix, and it is the most valuable item in this
document.

### 2. `normalizeCodeUri`, fixed on main while this was being written

We kept this one here because it is the case that prompted the survey,
and because what it settled sets the pattern for the rest.

Three producers disagreed three ways about the trailing slash. Two
consumers disagreed again, `startsWith` in one pass and `includes` fifty
lines further down the same file. None of the three stopped at a segment
boundary, so a scope of `src/foo` covered `src/foobar`, and the
`includes` spelling covered `vendor/src/foo` too. The producer whose
comment stated the invariant was the one that did not enforce it.

`codeScopePath` and `fileInCodeScope` in `@suss/ir-core` now own both
halves, and `runsIn` takes the scope path rather than a callback, which
is what had let the three call sites drift (#78).

Two things are worth carrying forward. The fix put the convention in the
package both sides already reach, next to `normalizePath` and
`bodyShapesMatch`, which are there for the same reason. It also landed
as a pair of functions rather than a type, which is the weaker form: a
caller can still be handed a scope string that never went through
`codeScopePath`, so `fileInCodeScope` has to normalise whatever it gets
to cover for that. The stronger form is in the types section below. Two
functions were the right call for a fix that had to keep reading
summaries written under the older conventions.

The SAM function reader kept its own behaviour, and that was right. It
produces a directory that something else joins onto a module path, so
stripping the trailing slash is the right thing to do there.

### 3. `process.env.X`, read three ways, two of which disagree

aws-sqs reads the raw AST and regex-matches the node text. aws-eventbridge
reads the already-extracted argument and regex-matches its name.
runtime-node walks the AST structurally with no regex.

The extractor inlines an identifier that resolves to a module-level
`const` with a `process.env` initializer. So this:

```ts
const BUS = process.env.ORDER_BUS;
```

resolves for EventBridge and does not resolve for SQS, because SQS looks
at a node that is still a bare identifier. The same code in the same
repo, and two different results. None of the three handles
`process.env["X"]`.

What this costs is a silent gap, not a few duplicated lines. Fixing it
means one reader over the extracted argument, which both AWS packs
already have in scope.

### 4. `buildInputs` emits two different shapes for one SDL field

The AppSync reader records the printed SDL source, so `arg: [ID!]!`
becomes `{type:"ref", name:"[ID!]!"}`. The GraphQL reader converts
structurally, so the same argument becomes `{type:"array",
items:{type:"text"}}`. Anything that compares an AppSync-derived summary
against a plain-SDL-derived one for the same field sees two different
structures and cannot match them.

The structural form is more useful downstream. The printed form keeps
the source text for a person reading the summary. Somebody has to choose
between them before these two merge.

### 5. Two coordinate systems in one fact relation

The reachable-closure pass mints node keys from character offsets. The
rethrow pass falls back to line numbers, because
`summary.location.range` is in lines. Both write into the same database
and the same relations. The comment at the fallback calls the result
"internally consistent either way", which is only true if the whole run
takes the fallback, and the code decides per summary.

This one is in the fact layer, which is under active change. We flagged
it and left it alone.

### 6. Type-declared-in-package, three implementations, two of them loose

The adapter anchors on `/node_modules/<module>/`. The prisma and drizzle
packs each match a bare substring, so a project file at
`src/@prisma/client/mock.ts` matches. Drizzle additionally falls back to
`getAliasSymbol()` and prisma does not, so a type alias resolves for one
and not the other.

Merging means giving prisma and drizzle a dependency on the TypeScript
adapter. Today they take ts-morph as a peer and depend on the extractor
only. That new edge is defensible, since both cast to ts-morph types on
their first line, but it changes their published dependency graph, so
somebody should decide it deliberately rather than in passing.

### 7. The channel string has a reader and no writer

`parseChannel` lives in the shared primitives package, and three
different places write `${bus}#${subject}` by hand because there is no
`formatChannel` next to it. A second reader in the checker splits the
string only when the bus is EventBridge, and otherwise treats the whole
string as the bus, so it disagrees with `parseChannel` for any other bus
whose name contains a `#`. The missing half is what causes this: when a
convention has a reader and no constructor, every writer spells it out
again.

### 8. Two contract readers walk AppSync, and the manifest reader is right

Both walk resolvers, pipeline functions and data sources to work out
which Lambda serves a field. They disagree twice, and the manifest
reader is correct both times: it scopes data-source names by API and
looks them up by name as well as by logical id, and it iterates whatever
root types it finds rather than hard-coding Query, Mutation and
Subscription. So the contract reader fails to attribute a Lambda for a
raw template that refers to a data source by `Name`, or for a SAM
template with a `User.posts` field resolver.

The contract reader needs strictly more per resolver than the manifest
reader does, so this means layering one on the other rather than
deleting either. It is a lot of work, and it should fix both
disagreements on the way through.

### 9. Twenty-nine peelers, eleven names, no two agreeing

The adapter peels value-preserving wrappers at 29 places. Eleven of them
are named functions and the rest are inline loops. No two of them agree
on which wrappers to peel:

| helper | parens | await | `as` | `!` | satisfies | `<T>` |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `unwrapValue` | yes | yes | yes | yes | yes | no |
| `peelSyntax` (was `unwrap` twice) | yes | no | yes | yes | yes | yes |
| `unwrapCasts` | yes | no | yes | yes | yes | no |
| `peelExpression` | yes | no | yes | yes | yes | no |
| `unwrapExpression` | yes | yes | yes | no | yes | no |
| `unwrap` in the field-access pass | yes | yes | yes | no | no | no |
| `resolveSubject` | yes | yes | yes | no | no | no |
| `stripDocumentNodeCasts` | yes | no | yes | no | no | no |
| `peelToObjectLiteral` | no | no | yes | no | yes | no |
| `peelParens` (was `unwrapParens` twice) | yes | no | no | no | no | no |
| `unwrapAs` | no | no | yes | no | no | no |

One of the inline copies is a single-level ternary rather than a loop,
so for `await (foo())` it peels the await, stops at the parentheses, and
hands back something no caller expects. Every other peeler loops. That
is a bug waiting to happen rather than a difference in style.

`await` is the only one of these columns that matters, and it lines up
with the two questions the repo asks. A pass that wants the type
TypeScript infers stops at the await, because TypeScript already reports
the resolved type there. A pass that is following a value looks through
it. Three names cover all 29 sites: `peelParens`, `peelSyntax`, and a
`peelValue` that also peels `await`. Two of the three landed in group
one.

Merging the rest changes behaviour at every site whose current peeler
peels the wrong set, which is most of them, so somebody has to check
each site against the question it is asking. About a dozen of the 29 are
in the discovery directory and the fact layer, so this comes after that
work.

## Group three: leave alone, and why

An audit that recommends merging everything is not an audit. These look
like duplication and are not.

**`buildTransitions`, four copies.** These are four different transition
models. Three of them emit a success plus an error pair; the fourth
emits one transition per declared response status, with literal and
range branches. The three that look alike differ in `confidence.source`
(`declared` for a committed GraphQL document, `derived` for SDL read out
of a template) and in `exceptionType`. Each difference says something
deliberate about how much the source knows. A helper with a parameter
for every difference would be longer than the three copies.

**`buildSummary`, three copies.** One builds a library summary with no
transitions, one a handler summary with a REST binding, one a component
summary with a render output. All three write the same field list,
because that is what `BehavioralSummary` is for.

**`readEnvVarTargets`, two copies.** One builds the map from a raw
template, the other reads the built map off metadata. They are the
producer and the consumer of the same wire format, and they share a name
and a return type because they sit at opposite ends of it. What is
missing is a shared type for the format, not a shared function.

**`objectToShape`, two copies.** One walks an OpenAPI schema object, one
walks a ts-morph `Type` with depth and cycle guards. They produce the
same output type from different input, using different machinery.
Merging would drag ts-morph into a contract reader.

**`parseStatusCode` and `parseStatus`.** OpenAPI response keys are always
strings and can be ranges like `2XX`. A CloudFormation
`MethodResponse.StatusCode` is a scalar that may arrive as a number and
is never a range. The range branch would be dead weight on one side and
the number branch would mean nothing on the other.

**`mulberry32`, two byte-identical copies.** The fuzzer does not depend
on the CLI, and a shared-primitives package should not carry a seeded
PRNG with published constants. It is nine lines that cannot drift.

**`safeParse`, three byte-identical copies.** Each one is a try/catch
around `graphql`'s `parse`, with no policy in it. Sharing it means
either a new package or putting `graphql` into the zero-dependency
primitives package, and neither is worth six lines. What is worth
noticing is that two of the four SDL-parsing sites cache the parse and
two do not.

**express, fastify and hono terminals.** Express writes to a response
object at parameter 1, hono returns from a context at parameter 0 with
the status as an argument, and fastify supports both plus a bare return.
Those are three different response models. Discovery is already shared,
and the terminals are data, about as short as data gets.

**nestjs-rest and nestjs-graphql.** The two are built the same way and
share no strings: different discovery variants, role maps with nothing
in common, and different terminal semantics. They look alike because the
pack SDK is doing its job.

**drizzle and prisma, past the type-declared-in question.** Prisma is a
fixed property chain with a method-name lookup. Drizzle is a fluent
chain, and recovering the SQL table name from it takes an anchor call,
a walk up the tree and a walk to the declaration. They channel on
different names on purpose, and an alias in a contract reader brings the
two back together at the checker.

**The three fuzzer drivers.** They use three different oracles:
execution, invariant, equivalence. Their file names line up and their
bodies share nothing.

**The coverage and workspace scripts.** These are already factored. One
module lists the packages, one reads the workspace manifests, one
normalizes a summary file, and four scripts import them. This is what
the rest should look like.

## Where a type would carry the invariant

We applied the same test throughout: what would the constructor refuse
to build? Where the answer is nothing, the type buys nothing, and the
functions should stay functions.

The repo already has one that works. `ResolutionStore` owns the fact
database and exposes six methods, each of which asks a question, and no
caller anywhere reaches a raw tuple. That is the pattern paying off.

**A code scope. Half of it is done, and the half left is the invariant.**
`codeScopePath` and `fileInCodeScope` landed on main and put the
convention in one place, which stops the three producers drifting again.
What a function cannot do is stop a caller from having a scope string
that never went through the constructor, which is why `fileInCodeScope`
has to re-normalise whatever it is given. A type would refuse three
things: a non-string, an empty or whitespace-only `CodeUri` (one
producer used to accept `""` and return `/`, which prefix-matches every
file in the tree), and a scope of `/` or `./`, because a scope that
matches everything is a problem in the template, worth telling somebody
about rather than writing into a summary. Nothing rejects any of those
three today. What gets in the way is that summaries already on disk were
written under the older conventions, so the constructor has to accept
them on the way in. That is a question about versions rather than a
reason not to have the type.

**A channel. Yes.** Three writers, two readers that disagree, and one of
those readers already in the shared package with no constructor next to
it. The constructor would refuse a bus segment that contains the
separator, which nothing rejects today and which makes the split
ambiguous.

**A pack identity. Yes.** Every pack has a short name and a
`recognition` string that has to be its own package name, and somebody
retyped that by hand at eleven places across four packs. Nothing checks
them. Copy-paste a new bus pack and it emits the old pack's
`recognition`, and every test still passes, because the field feeds
provenance and attribution, so the only symptom is a report that blames
the wrong pack. Build the emitter once per pack and you cannot express
the mistake. It would also have caught something that is wrong today:
one runtime-node effect builder hardcodes the deployment target where
its sibling passes through the configured one, and an emitter that
already has those values gives that builder nowhere to drop them.

**The fact database the closure writes into. Yes.** Same argument as
`ResolutionStore`, on the same kind of data, and it is the one place in
the adapter where something still reads raw tuples directly. If the only
method that mints a key takes a ts-morph node, you cannot write the
line-number fallback in group two item 5 at all. It is in the fact
layer, so it waits.

**A per-pair status view. Probably.** Six checks take `(provider,
consumer)` and each one re-derives the same three things: the consumer's
status accessors, its explicit status set plus whether it has a default,
and which of its transitions handle a given status. They also run in a
fixed order, and one of them says nothing on purpose because a later one
will report it, which is written down in a comment and nowhere else. If
you built the pair object once, it would refuse a status question that
skipped the consumer's declared accessors, which is the mistake one of
the six makes today by inlining the 2xx range where the others call the
shared predicate. Worth doing, and bigger than it looks.

**A summary reference. Not yet.** The function landed in group one and
removes the 19 hand-written copies. The stronger version is a branded
string that only the constructor can produce, which would refuse a bare
string built any other way. That reaches into the IR schema, where the
field is a plain string today, so it is a separate change.

**Findings. No.** There are forty-three construction sites, but the
closed unions in the IR already enforce everything a constructor could.
The one invariant left is on the `sources` array, where sorting is what
makes the output deterministic and somebody retyped it by hand at five
sites. If one site forgets to sort, the output fails only sometimes.
What that calls for is a constructor for `sources`, not a builder for
findings.

**TypeShape and SourceLocation. No.** Both are zod-validated wire
values, so the first parse erases whatever invariant a constructor
enforced. What each of them needs is one function: a union constructor
that always dedupes and always handles the empty case (three call sites
remember this three different ways today), and a location constructor,
since nine contract readers write a placeholder range and disagree about
whether it is `{0,0}` or `{1,1}`.

**Discovery handlers, pure argument readers, the fuzzer's generators.
No.** These are repeated argument lists with no shared state and no
constraint on ordering. A context object would move the same values
behind a dot.

## Structure that is not carrying its weight

**`adapter.ts`, 2,183 lines, four exports.** It marks its own seams with
section banners, eight of them, and at least four of those sections
(parameter extraction, response property resolution, consumer binding
extraction, wrapper expansion) could move to sibling files without
creating an import cycle.

**`inspect.ts`, 1,486 lines.** It contains three CLI commands plus all
their rendering.

**`messageBusPairing.ts`, 732 lines.** It does four jobs. The body-shape
pass at the end is a second, independent pairing loop with its own
record type and its own scope filter, and the only thing it shares is
the producer list.

**`responseMatch.ts` is the checker's highest fan-in and has an annex.**
It has eight importers. Three of them want only `makeSide` and take no
interest in status codes at all, and one of them is not even HTTP.
Pulling the finding-side construction out into its own file would fix
the fan-in and give the 26 inline finding literals somewhere to go.

**`conditions.ts` is the adapter's highest fan-in for the wrong reason.**
Twenty of its twenty-four importers want a type alias that has nothing to
do with conditions.

**No rule registry in the checker.** Six per-pair checks are hard-coded
in one function, seven whole-run passes in another, and sixteen
re-exports in a third, so adding a new check means editing `index.ts` in
three places. There is no way to list the checks, filter them, or time
them one by one. There is one hand-written exception, because all six
per-pair checks assume HTTP, and a registry would instead let each check
declare what it applies to. The pieces are already there: the
interaction dispatcher registers pairing passes by class and semantics,
and finding kinds are already a closed union.

**Naming is consistent.** Files are camelCase and directories kebab-case
throughout `packages/` and `tools/`. The only leftovers are ten checker
files whose header comment mentions a kebab-case filename that no longer
exists, and three scripts still named in kebab-case. Deleting the
filename from a header comment is better than correcting it, for the
same reason the conventions say not to cite paths in comments.

**`packages/ir/` is not a package.** It has no manifest and no tracked
files, so the workspace glob skips it. It is the build output left behind
when `packages/ir` became `packages/behavioral-ir`. Its stale type
declarations still re-export from the shared primitives package, which is
the only mild hazard. It is safe to delete.

## What was measured

After group one, the summaries came out byte-identical on twenty-front
(6,524 summaries), saleor-dashboard (3,071), saleor-storefront (536) and
directus/api (645). The full suite, typecheck, lint, `check:fuzz`,
`check:self`, `check:vocabulary`, `check:style` and the coverage gate all
pass. The dogfood baseline changes: 10 fewer internal units, which are
exactly the ten functions we deleted, and 3 more exports, which are the
places we consolidated them into. The 7 units gained in
`@suss/behavioral-ir` come from the type-only-import gap described in
group one.
