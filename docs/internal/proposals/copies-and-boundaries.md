# Where the same thing is written twice

Three copies of `normalizeCodeUri` disagreed about a trailing slash. One
appended it, one kept whatever the template wrote, one stripped it. The
field they produce is prefix-matched against summary file paths by the
checker, and the checker read it two ways as well, `startsWith` in one
place and `includes` in another. That was four spellings of one
convention on a field that decides which Lambda a finding names. #78
fixed it while this was being written.

This survey looked for the rest of that pattern across every package.
Forty-six clusters are written up below, eight of them merged in this
change. The ranking is by evidence: a copy that already disagrees ranks
above a copy that merely exists, and a disagreement that reaches output
ranks above one absorbed by its callers.

Counts from the public corpora are given in full. A run against a
production monorepo is described only as a ratio, which says nothing
about that codebase's shape.

## Two things decide the ranking

**Do the copies already disagree?** Where they agree, merging is
arithmetic and the only question is where the survivor lives. Where they
disagree, merging means choosing, and something changes. The two are
separated below because they are different kinds of work, not different
sizes of the same work.

**Does the disagreement reach output?** `makeSide` differs between two
files on whether an empty transition id is written out, and no caller
passes an empty transition id, so nothing observable moves. `refTarget`
differs on whether `Fn::GetAtt` resolves, and the spelling it drops is
the one AWS's own documentation uses. Both are two copies that disagree.
Only one is a bug.

A third thing shaped the survey more than expected. The largest single
duplication in the repo is not in the product code. Thirty-one test
files construct a ts-morph `Project`, thirty-eight times, and they do
not agree: `target` is 99 in most, 9 in two, `ScriptTarget.ES2022` in
five; `jsx` is 4 in three and 2 in one; `moduleResolution` is absent in
about half. Eleven of those construct the adapter afterwards in a
function called `runAdapter`, four of them byte-identical once the pack
name is substituted. Two packs go further and hand-roll their own
`extractArgs`, so aws-sqs and aws-eventbridge are each unit-tested
against a different and incorrect model of the input they receive in
production. Neither test double inlines a module-level `const`, which
the adapter does, which is why the `process.env` divergence in the next
section survived.

## Group one: copies that agree

Implemented in this change. Every one is byte-identical or provably
equivalent, so no output moves. Verified: byte-identical summaries on
twenty-front, saleor-dashboard, saleor-storefront and directus/api.

| what | sites | home it moved to |
|---|---|---|
| the `file::name` string a finding names a summary by | 19 | `summaryRef` in `@suss/behavioral-ir` |
| `dispatchByType` + `DispatchTable` | 3 | `@suss/ir-core` |
| `unwrapBodyField` | 2 | the checker's declared-contract module |
| `isSuccessStatus`, counting three inline copies of the range | 5 | the checker's response-match module |
| `unwrapInitializer` and `unwrap`, byte-identical | 2 | `peelSyntax` in the adapter's walk module |
| `unwrapParens` | 2 | `peelParens`, same module |
| `isAncestorOrSelf` | 2 | the adapter's conditions module |
| a status fold that re-implemented two helpers its own file imports | 1 | calls the imports |

Two of these deserve more than a table row.

**The summary reference.** `${location.file}::${identity.name}` was
written out at 19 places across three packages. Every copy agreed, so
nothing was broken, but the string is parsed as well as printed: the
checker deduplicates findings by it, and a `.sussignore` rule matches
against it. Nineteen authors of a wire format is how a twentieth picks a
different separator. It now has one constructor.

**The dispatch table.** Three byte-identical copies, one of which had
already been extracted into its own file in the fuzzer with the style
decision cited in its header. The idiom is a repo-wide rule, so it
belongs in the package that owns repo-wide primitives rather than in
three packages that each rediscovered it.

**The peelers.** `unwrapInitializer` in the resolution pass carried a
docstring saying it must mirror the shape pass's `unwrap` except that it
does not peel `await`. The shape pass's `unwrap` does not peel `await`
either, and says so four lines further down. The bodies were identical
and the comment describing the difference was describing nothing. The
two now share `peelSyntax`. That closes 2 of the 29 sites that peel
wrappers. The other 27 disagree with each other, so they are item 9
below.

One incidental result. Adding a value import to `interpret.ts` put it in
the module graph for the first time, and suss now sees 7 units inside it
that were previously invisible. A module reached only by a type-only
import is not walked. That is a gap worth its own look.

## Group two: copies that disagree

Not implemented here. Each needs a decision about which behaviour is
right, and each changes output.

### 1. `refTarget` drops `Fn::GetAtt`, and SQS consumers vanish

Six functions across two packages answer "which logical id does this
value name", with four different answers. The one used for
`AWS::Lambda::EventSourceMapping.FunctionName` handles `Ref` and a bare
string and returns null for `Fn::GetAtt`. `FunctionName: !GetAtt
OrdersWorker.Arn` is the spelling AWS documents, because the property
takes an ARN.

Measured on a four-resource template, changing only that one line:

```
FunctionName: !Ref OrdersWorker        3 summaries, consumer present
FunctionName: !GetAtt OrdersWorker.Arn 2 summaries, consumer gone
```

The `OrdersWorker.EventSourceMapping` consumer summary is what tells the
checker which Lambda reads the queue. Without it the queue reads as
unconsumed.

Twenty lines above the broken copy, the EventBridge path uses a version
that does unwrap `Fn::GetAtt`, and its docstring names the divergence:
"Unlike the local `refTarget` used by the SQS paths, this also unwraps
`Fn::GetAtt`". The difference was noticed, written down, and left. The
EventBridge behaviour is right; the SQS path should take it. Every input
the broken copy accepts, the working copy answers identically, so the
merge direction is not in question.

One of the six must keep its difference. The env-var reader rejects a
bare string on purpose, because a plain string env-var value is data
rather than wiring, and resolving it would invent a reference. That
exception has to survive the merge.

Cost: small, and it is the highest-value item in this document.

### 2. `normalizeCodeUri`, fixed on main while this was being written

Kept here because it is the case that prompted the survey and because
what it settled sets the pattern for the rest.

Three producers disagreed three ways about the trailing slash. Two
consumers disagreed again, `startsWith` in one pass and `includes`
fifty lines further down the same file, and none of the three stopped
at a segment boundary, so a scope of `src/foo` covered `src/foobar` and
the `includes` spelling covered `vendor/src/foo` too. The producer whose
comment stated the invariant was the one that did not enforce it.

`codeScopePath` and `fileInCodeScope` in `@suss/ir-core` now own both
halves, and `runsIn` takes the scope path rather than a callback, which
is what had let the three call sites drift (#78).

Two things to carry forward. The fix put the convention in the package
both sides already reach, next to `normalizePath` and `bodyShapesMatch`,
which are there for the same reason. And it landed as a pair of
functions rather than a type. That is the weaker form: a caller can
still hold a scope string that never went through `codeScopePath`, and
`fileInCodeScope` normalises whatever it is handed to cover for that.
The stronger form is in the types section below. The functions were the
right call for a fix that had to keep reading summaries written under
the older conventions.

The SAM function reader kept its own behaviour, correctly. Its output is
a directory that gets joined onto a module path, so stripping the
trailing slash is right there.

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
at a node that is still a bare identifier. Same shape, same repo, two
answers. None of the three handles `process.env["X"]`.

This is a silent gap rather than a line count. Fixing it means one
reader over the extracted argument, which both AWS packs already have in
scope.

### 4. `buildInputs` emits two different shapes for one SDL field

The AppSync reader records the printed SDL source, so `arg: [ID!]!`
becomes `{type:"ref", name:"[ID!]!"}`. The GraphQL reader converts
structurally, so the same argument becomes `{type:"array",
items:{type:"text"}}`. Anything comparing an AppSync-derived summary
against a plain-SDL-derived one for the same field sees two different
shapes and cannot match them.

The structural form is more useful downstream. The printed form
preserves the source text for a person reading the summary. Somebody has
to pick before these merge.

### 5. Two coordinate systems in one fact relation

The reachable-closure pass mints node keys from character offsets. The
rethrow pass falls back to line numbers, because `summary.location.range`
holds lines. Both write into the same database and the same relations.
The comment at the fallback calls the result "internally consistent
either way", which holds only if the fallback is taken for the whole run,
and it is taken per summary.

This is in the fact layer, which is under active change. Flagged, not
touched.

### 6. Type-declared-in-package, three implementations, two of them loose

The adapter anchors on `/node_modules/<module>/`. The prisma and drizzle
packs each match a bare substring, so a project file at
`src/@prisma/client/mock.ts` matches. Drizzle additionally falls back to
`getAliasSymbol()` and prisma does not, so a type alias resolves for one
and not the other.

Merging means giving prisma and drizzle a dependency on the TypeScript
adapter. They currently take ts-morph as a peer and depend on the
extractor only. The edge is defensible, since both cast to ts-morph
types on their first line, but it changes their published dependency
graph and needs a decision rather than a drive-by.

### 7. The channel string has a reader and no writer

`parseChannel` lives in the shared primitives package, and three
different places write `${bus}#${subject}` by hand because there is no
`formatChannel` beside it. A second reader in the checker splits only
when the bus is EventBridge and otherwise treats the whole string as the
bus, which disagrees with `parseChannel` for any other bus carrying a
`#`. The asymmetry is the cause: a convention with a reader and no
constructor gets spelled out by every writer.

### 8. Two contract readers walk AppSync, and the manifest reader is right

Both walk resolvers, pipeline functions and data sources to answer which
Lambda serves a field. They disagree twice, and the manifest reader is
correct both times: it scopes data-source names by API and looks them up
by name as well as logical id, and it iterates whatever root types are
present rather than hard-coding Query, Mutation and Subscription. So a
raw template referencing a data source by `Name`, or a SAM template with
a `User.posts` field resolver, loses its Lambda attribution in the
contract reader.

The contract reader needs strictly more per resolver than the manifest
reader does, so this is a layering job rather than a deletion.
Substantial work, and it should fix both disagreements on the way
through.

### 9. Twenty-nine peelers, eleven names, no two agreeing

The adapter peels value-preserving wrappers at 29 places. Eleven of them
are named functions and the rest are inline loops. No two agree on which
wrappers they peel:

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
so `await (foo())` peels the await, stops at the parentheses, and hands
back something no caller expects. Every other peeler loops. That is a
latent bug rather than a style difference.

`await` is the only axis that matters, and it maps onto the two
questions the repo asks. A pass wanting the type TypeScript infers stops
at the await, because TypeScript already reports the resolved type
there. A pass following a value sees through it. Three names cover all
29 sites: `peelParens`, `peelSyntax`, and a `peelValue` that adds
`await`. Two of the three landed in group one.

Merging the rest changes behaviour at every site whose current peeler
has the wrong axis set, which is most of them, so each site needs
checking against what it asks. About a dozen of the 29 sit in the
discovery directory and the fact layer, so this sequences after that
work.

## Group three: leave alone, and why

An audit that recommends merging everything is not an audit. These look
like duplication and are not.

**`buildTransitions`, four copies.** Four transition models. Three emit
a success plus an error pair; the fourth emits one transition per
declared response status with literal and range branches. The three that
look alike differ in `confidence.source` (`declared` for a committed
GraphQL document, `derived` for SDL read out of a template) and in
`exceptionType`. Each difference is a deliberate statement about how much
the source knows. A helper parameterised by every difference would be
longer than the three copies.

**`buildSummary`, three copies.** A library summary with no transitions,
a handler summary with a REST binding, a component summary with a render
output. They share the field list of `BehavioralSummary`, which is the
type's job.

**`readEnvVarTargets`, two copies.** One builds the map from a raw
template, the other reads the built map off metadata. Producer and
consumer of the same wire format, sharing a name and a return type
because they sit at opposite ends of it. What is missing is a shared
type for the format, not a shared function.

**`objectToShape`, two copies.** One walks an OpenAPI schema object, one
walks a ts-morph `Type` with depth and cycle guards. Same output type,
different input and different machinery. Merging would drag ts-morph
into a contract reader.

**`parseStatusCode` and `parseStatus`.** OpenAPI response keys are always
strings and can be ranges like `2XX`. A CloudFormation
`MethodResponse.StatusCode` is a scalar that may arrive as a number and
is never a range. The range branch would be dead weight on one side and
the number branch meaningless on the other.

**`mulberry32`, two byte-identical copies.** The fuzzer does not depend
on the CLI, and a seeded PRNG with published constants is not something
a shared-primitives package should carry. Nine lines that cannot drift.

**`safeParse`, three byte-identical copies.** A try/catch around
`graphql`'s `parse` with no policy in it. Sharing it means either a new
package or putting `graphql` into the zero-dependency primitives
package, and neither is worth six lines. What is worth noticing is that
two of the four SDL-parsing sites cache the parse and two do not.

**express, fastify and hono terminals.** Express writes to a response
object at parameter 1, hono returns from a context at parameter 0 with
the status as an argument, fastify supports both plus a bare return.
Three response models. Discovery is already shared; the terminals are
data and are about as short as data gets.

**nestjs-rest and nestjs-graphql.** Structurally parallel and sharing no
strings: different discovery variants, disjoint role maps, different
terminal semantics. The parallelism is the pack SDK working.

**drizzle and prisma, past the type-declared-in question.** Prisma is a
fixed property chain with a method-name lookup. Drizzle is a fluent
chain needing an anchor call, an upward walk and a declaration walk to
recover the SQL table name. They channel on different names on purpose,
and a contract reader's alias reconciles them at the checker.

**The three fuzzer drivers.** Different oracles: execution, invariant,
equivalence. Parallel file names, unshared bodies.

**The coverage and workspace scripts.** These are already factored. One
module lists the packages, one reads the workspace manifests, one
normalizes a summary file, and four scripts import them. This is what
the rest should look like.

## Where a type would carry the invariant

The test applied throughout: what would the constructor refuse to build?
Where the answer is nothing, the type buys nothing and the functions
should stay functions.

The repo already has one that works. `ResolutionStore` holds the fact
database and answers six question-shaped methods, and across every
consumer no caller reaches a raw tuple. That is the pattern paying.

**A code scope. Half of it is done, and the half left is the invariant.**
`codeScopePath` and `fileInCodeScope` landed on main and put the
convention in one place, which stops the three producers drifting again.
What a function cannot do is stop a caller holding a scope string that
never went through the constructor, which is why `fileInCodeScope` has
to re-normalise whatever it is handed. A type would refuse: a
non-string, an empty or whitespace-only `CodeUri` (one producer used to
accept `""` and yield `/`, which prefix-matches every file in the tree),
and a scope of `/` or `./`, because a scope that matches everything is a
template problem worth surfacing rather than a summary worth emitting.
None of those three is rejected today. The obstacle is that summaries on
disk were written under the older conventions, so the constructor has to
accept them on the way in; that is a version question rather than a
reason not to have the type.

**A channel. Yes.** Three writers, two disagreeing readers, and a reader
already in the shared package with no constructor beside it. The
constructor refuses a bus segment containing the separator, which
nothing rejects today and which makes the split ambiguous.

**A pack identity. Yes.** Every pack carries a short name and a
`recognition` string that must be its own package name, retyped by hand
at eleven places across four packs. Nothing checks them. A copy-paste
into a new bus pack emits the old pack's `recognition` and every test
passes, because the field feeds provenance and attribution, so the only
symptom is a report blaming the wrong pack. An emitter constructed once
per pack makes it unrepresentable. It would also have caught a live case:
one runtime-node effect builder hardcodes the deployment target where
its sibling threads the configured one, and an emitter holding those
values has nowhere to drop them.

**The fact database the closure writes into. Yes.** Same argument as
`ResolutionStore`, on the same kind of data, and it is the one place in
the adapter where raw tuples are still read directly. A class whose only
key-minting method takes a ts-morph node makes the line-number fallback
in group two item 5 unwriteable. In the fact layer, so it waits.

**A per-pair status view. Probably.** Six checks take `(provider,
consumer)` and each re-derives the same three things: the consumer's
status accessors, its explicit status set plus whether it has a default,
and which of its transitions handle a given status. They also run in a
fixed order, and one of them stays deliberately silent because a later
one will speak, which is recorded in a comment and nowhere else. A pair
object built once would refuse a status question that skipped the
consumer's declared accessors, which is the mistake one sibling makes
today by inlining the 2xx range where the others call the shared
predicate. Worth doing, and larger than it looks.

**A summary reference. Not yet.** The function landed in group one and
removes the 19 hand-written copies. The stronger version is a branded
string that only the constructor can produce, which would refuse a bare
string built any other way. That reaches the IR schema, where the field
is a plain string today, so it is a separate change.

**Findings. No.** Forty-three construction sites, but the closed unions
in the IR already enforce everything a constructor could. The one
invariant left is on the `sources` array, where sorting is what makes output
deterministic and is retyped by hand at five sites; one site forgetting
it produces output that only fails intermittently. That is a constructor
for `sources`, not a builder for findings.

**TypeShape and SourceLocation. No.** Both are zod-validated wire values,
so a constructor invariant is erased on the first parse. What they want
is one function each: a union constructor that always dedupes and always
handles empty (three call sites remember this three different ways
today), and a location constructor, since nine contract readers write a
placeholder range and disagree about whether it is `{0,0}` or `{1,1}`.

**Discovery handlers, pure argument readers, the fuzzer's generators.
No.** Repeated argument lists with no shared state and no ordering
constraint. A context object moves the same values behind a dot.

## Structure that is not carrying its weight

**`adapter.ts`, 2,183 lines, four exports.** It marks its own seams with
section banners, eight of them, and at least four of those sections
(parameter extraction, response property resolution, consumer binding
extraction, wrapper expansion) would move to sibling files with no
import cycle.

**`inspect.ts`, 1,486 lines.** Three CLI commands plus all their
rendering.

**`messageBusPairing.ts`, 732 lines.** Four jobs. The body-shape pass at
the end is an independent second pairing loop with its own record type
and its own scope filter, sharing only the producer list.

**`responseMatch.ts` is the checker's highest fan-in and has an annex.**
Eight importers, three of which want only `makeSide` and have no
interest in status codes at all, one of which is not even HTTP. Splitting
finding-side construction out would fix the fan-in and give the 26
inline finding literals somewhere to go.

**`conditions.ts` is the adapter's highest fan-in for the wrong reason.**
Twenty of its twenty-four importers want a type alias that has nothing to
do with conditions.

**No rule registry in the checker.** Six per-pair checks are hard-coded
in one function, seven whole-run passes in another, and sixteen
re-exports in a third, so a new check edits `index.ts` in three places.
There is no way to enumerate the checks, filter them, or time them
individually. One hand-written exception exists because the six per-pair
checks all assume HTTP, which a registry would express as declared
applicability. The pieces are already in place: the interaction
dispatcher registers pairing passes by class and semantics, and finding
kinds are already a closed union.

**Naming holds.** Files are camelCase and directories kebab-case
throughout `packages/` and `tools/`. The only residue is ten checker
files whose header comment names a kebab-case filename that no longer
exists, and three scripts still spelled kebab-case. Dropping the
filename from a header comment is better than correcting it, for the
same reason the conventions say not to cite paths in comments.

**`packages/ir/` is not a package.** It has no manifest and no tracked
files, so the workspace glob skips it. It is the build output left behind
when `packages/ir` became `packages/behavioral-ir`. Its stale type
declarations still re-export from the shared primitives package, which is
the only mild hazard. Safe to delete.

## What was measured

Byte-identical summaries after group one on twenty-front (6,524
summaries), saleor-dashboard (3,071), saleor-storefront (536) and
directus/api (645). Full suite, typecheck, lint, `check:fuzz`,
`check:self`, `check:vocabulary`, `check:style` and the coverage gate all
pass. The dogfood baseline moves: 10 fewer internal units, which are
exactly the ten deleted functions, and 3 more exports, which are their
consolidated homes. The 7 units gained in `@suss/behavioral-ir` are the
type-only-import gap noted in group one.
