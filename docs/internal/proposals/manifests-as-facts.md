# Reading deploy manifests as facts

Status: draft, seeking alignment. Nothing implemented.

## The problem

A deploy template is a graph of resources joined by names. `Ref` names a
resource, `GetAtt` names one and reads an attribute off it, a nested
stack passes parameters down and hands outputs back up. Following a name
to what it eventually means is the problem `comesTo` already solves for
TypeScript values, and `@suss/resolution` already holds rules for that
shape: a name binds to a value, an import chains to an export, a
re-export chains again.

We wrote a bespoke walker for templates instead. Three measured gaps are
places that walker stops.

**Only the root document is read.** The aws-lambda pack walks up from a
source file to the nearest `template.yaml` and parses that one file. One
service in a production serverless monorepo declares 156 handlers across
nine documents, and the pack finds the 34 in the root and none of the
122 in the eight children, because a child is reached through
`AWS::CloudFormation::Stack` and nothing follows that edge.

**The runtime-config check produces 1,874 false errors on one service.**
It scopes a handler's `process.env.X` read to a Lambda by a `startsWith`
prefix match on the file path. In that monorepo all 277 Lambdas share a
CodeUri with at least one other Lambda; the largest group is 91 Lambdas
on one path, and every one of the 16 templates gives every function it
declares the same CodeUri. The prefix separates nothing, so every read
in a service pairs against every function's contract. One service has
294 `process.env` read sites over 58 distinct names against 34 root
functions, which is the order of the 1,874.

**Queue findings did not move** when handler discovery on one service
went from 0 to 90. Consumer orphans stayed at 81 and unused stayed near
84, because those findings are about wiring the walker reads separately
from handlers.

## What the templates actually contain

Every count below comes from the SAM templates in that monorepo, 16
documents across 8 services.

| | |
|---|---|
| resources | 1,030 |
| leaf property values | 11,162 |
| `Ref` | 1,348 |
| `Fn::GetAtt` | 921 |
| `Fn::Sub`, all interpolating | 1,218 |
| nested stacks | 9 |
| parameters declared / bound into a child | 237 / 158 |
| outputs | 167 |
| Lambda functions | 277 |
| declared env vars | 349 |
| queues / rules | 195 / 46 |
| `Fn::If` values | 48 |
| `Fn::FindInMap` / `Fn::ImportValue` | 16 / 2 |

Two things stand out. References dominate: 1,348 `Ref` plus 921 `GetAtt`
plus 2,114 substitution tokens inside `Fn::Sub`, against 1,030
resources. Following names is most of what reading a template is. And
the intrinsics nobody can evaluate statically are 18 values out of
11,162.

## The design

### Two layers, and where the line falls

The TypeScript adapter owns the language and a framework pack declares
what a library means on top of it. Manifests have no equivalent layer
today, so `@suss/manifest-aws` and `@suss/contract-cloudformation` mix
both jobs in one file. Apply the same test and the split is clear.

CloudFormation's own semantics are that a document declares named
resources, a value can name one of them, a value can read an attribute
off the thing it names, a document declares parameters and publishes
outputs, and a resource can embed another document. None of that
mentions AWS.

What AWS means is that `AWS::Serverless::Function` runs code named by a
`Handler` string, that an event source mapping wires a queue to a
function, and that an `AWS::Events::Rule` routes a subject into its
targets. That is a technology's meaning and belongs in a pack.

So the format-neutral relations are:

    document(d)
    declares(d, id, node)          d declares id, which is node
    hasType(node, t)
    property(node, path, value)
    namesTarget(d, value, id)      value names id, in d's namespace
    readsAttribute(value, attr)
    embedsDocument(node, d2)
    declaresParameter(d, name)
    bindsParameter(node, name, value)
    publishesOutput(d, name, value)
    isLiteral(value, text)
    interpolates(value, token)
    alternative(value, branch)
    guardedValue(value, condition)
    guardedBy(node, condition)
    opaqueValue(value, kind)
    locatedAt(node, d, line, column)

and the AWS relations a pack derives on top are `runsCode`,
`declaresEnvVar`, `deliversTo`, `routesInto` and `reaches`.

The one derived relation on the neutral side is `comesTo(name, node)`,
following a name to what it arrives at, which is the same sentence
`@suss/resolution` uses for the same idea. Manifest node identity is
`document#logicalId` and code node identity is `file:start-end`, so the
two never collide, but the rules stay in separate modules because they
are siblings rather than one set.

### Nested stacks

A reference into a child document's parameter continues at whatever the
parent bound to that parameter, and a reference to a child stack's
output continues at what the child published. Both are the shape the
import rules already use.

    comesTo(n, node) :- namesTarget(d, n, id), declares(d, id, node).

    comesTo(n, z)    :- namesTarget(child, n, p),
                        declaresParameter(child, p),
                        embedsDocument(stack, child),
                        bindsParameter(stack, p, bound),
                        comesTo(bound, z).

    comesTo(n, z)    :- namesTarget(d, n, id), declares(d, id, stack),
                        embedsDocument(stack, child),
                        readsAttribute(n, attr),
                        outputAttribute(child, attr, value),
                        comesTo(value, z).

Set those beside the import rules and the correspondence is exact. A
document is a module, a parameter is an import, an output is an export,
and `bindsParameter` is what `exportsAs` is for the other direction.
Recursion through `comesTo` gives arbitrary nesting depth, so a
grandchild costs no new rule. Nothing here is a new mechanism.

### Env var scoping

The code side reads `process.env.X` somewhere in a file. The template
side declares X on a function. Joining them needs a key both sides can
name, and today the key is a path prefix, which is why it fails.

    declaresEnvVar(fn, name) :- hasType(fn, "AWS::Serverless::Function"),
                                envVarProperty(fn, name).

    runsCode(fn, handler)    :- hasType(fn, "AWS::Serverless::Function"),
                                property(fn, "Handler", handler).

`runsCode` gives the module and export each function points at, so the
adapter already knows which function a summary belongs to when it
discovers the unit. The read then joins on the function node, and the
path never appears. Two Lambdas on one CodeUri are two different nodes
and share nothing.

That is the same conclusion the deployable-unit fix reaches by a shorter
route, and the two do not conflict. That fix stamps the function's
identity on the summary and compares identities, keeping the path as a
fallback for code that names no unit. This design supplies the identity
from the template side as a fact rather than as a stamped field, and
deletes the fallback. So the tactical fix survives, and this replaces
the fallback it leaves behind, which is the part that would otherwise
keep the prefix match alive forever.

### Queue and rule wiring

An event source mapping is an edge from a queue to a function. A rule is
an edge from a subject to a queue. A relay is those two edges meeting.

    deliversTo(q, fn) :- hasType(fn, "AWS::Serverless::Function"),
                         property(fn, p, ref), sqsEventQueueProperty(p),
                         comesTo(ref, q), hasType(q, "AWS::SQS::Queue").

    routesInto(r, q)  :- hasType(r, "AWS::Events::Rule"),
                         property(r, p, ref), ruleTargetProperty(p),
                         comesTo(ref, q), hasType(q, "AWS::SQS::Queue").

    reaches(r, fn)    :- routesInto(r, q), deliversTo(q, fn).

`reaches` is one join of two facts that were already there. The channel
rewrite in `buildLambdaConsumerSummary` exists because the edge from a
rule to the queue it feeds is not represented, so the reader forges a
subject identity onto the consumer to keep the pairing from reporting an
orphan. Once `routesInto` is a fact the rewrite has nothing left to do,
and `buildQueueSubjectMap` and `singleRoutedSubjectOf` go with it. This
is the mechanism the message-bus-identity proposal asks for, arriving as
a join rather than as new machinery.

### What each side can know alone

The code side, with no template, knows that a module exports a function,
that a value is read from `process.env.X`, and that a call sends to a
channel the code names, which is usually an env var name. It cannot know
its own function's logical id, which env vars are provided, which queue
is attached, or what subject arrives.

The template side knows all the wiring, and knows the module path and
export name each function points at. It cannot know what the code does
with any of it.

So the deployed function is a key both sides can name, and only because
the template hands it over through `runsCode`. The channel is not. The
code names an env var and only the template says what that env var
holds, which is why `envVarTargets` exists as a metadata bridge today.
Under this design that bridge becomes a join:

    configures(fn, name, target) :- declaresEnvVar(fn, name),
                                    envVarProperty(fn, name),
                                    property(fn, path, value),
                                    comesTo(value, target).

A key one side can never construct is not a key, and that is the same
reason the message-bus-identity proposal gives for taking the boundary
binding off the code side.

## What this deletes

Six near-duplicate functions unwrap a `Ref` or a `GetAtt` today, spread
over three files: `refTarget` in the template loader and again in
`messageBus`, `resolveQueueChannel`, `resolveLogicalId`,
`resolveEventBusToken`, and `readRefTarget`. They disagree. One returns
the logical id for a bare string, one segments an ARN first, one handles
the dotted short form of `GetAtt` and one does not. All six become
`namesTarget` plus `readsAttribute`, emitted once.

Three copies of `normalizeCodeUri` exist with three different trailing
slash conventions. One strips the slash, one appends it, and one keeps
whatever was authored while a comment explains that the checker's prefix
match depends on it. All three go with the prefix match.

The rest:

- `indexForTemplate`'s single-document traversal in the aws-lambda pack.
- `readServerlessFunctions`, the resource loop and `classifyEvents`. The
  `Handler` string split stays, because string surgery belongs in
  extraction.
- `buildQueueSubjectMap`, `singleRoutedSubjectOf`, `readRuleTargets`,
  and the routed-subject channel rewrite.
- `readEnvVarTargets` and `metadata.runtimeContract.envVarTargets`.
- The path-prefix scoping at all three checker sites: the `startsWith`
  filter in runtime-config pairing, `findRuntimeForFile` in message-bus
  pairing, and the substring match in `collectReceives`.
- `readCodeScope`, in all three of its copies, and `metadata.codeScope`
  with it.

That comes to roughly 500 lines of traversal and resolution across five
files. The emitter that replaces it is about 150 lines (the prototype
that produced the numbers in this document is 120) plus a dozen rules.
Net deletion is around 350 lines, and the drift between the six
unwrappers and the three path conventions stops being possible rather
than being fixed.

Special-casing for `Ref` and `GetAtt` does not survive anywhere. What
survives is `Fn::FindInMap` and `Fn::ImportValue` as `opaqueValue`,
which is 18 values in the whole corpus.

## Risks

**Error reporting.** A relation carries no file or line unless the facts
do, so `locatedAt` has to be emitted and every finding has to join
against it. Two measured cases need this. One child document in that
monorepo is referenced by a `TemplateURL` and is not on disk, so 9
`AWS::CloudFormation::Stack` resources resolve to 8 files. And 7 names
in the corpus name nothing declared in their document. Neither is
reportable today, because every summary the CloudFormation reader emits
carries `range: { start: 1, end: 1 }`. The YAML parser gives node
ranges, so the fact form makes this better rather than worse, but only
if `locatedAt` lands with the first relation rather than later.

**Cost.** These numbers come from running it. Emitting the facts for all 16
documents and running the rules takes 232ms to emit and 162ms to
evaluate, producing 19,822 base facts and 2,760 derived. The largest
single document, 342 resources, is 6,748 base facts and 69ms. Against
that, extracting one small service with `--no-cache` takes 4.21s. So the
manifest side is a few percent of a run.

Scaling: `property` is linear in leaf values, about 9 per resource.
`comesTo` came out at 1,909 for 4,021 references, so it is linear in
references in practice because the chains are shallow. The join that
could misbehave is the output-chaining rule, which pairs every stack
against every output of its child. Nine stacks and 167 outputs never bit
here; deep nesting with wide outputs is the shape that would, and it is
worth a guard rail rather than an assumption.

**What is not a graph problem.** `Fn::Sub` with inline substitution is
string work, and it stays in extraction: tokenize the string and emit
one `interpolates` edge per `${}`. That follows the discipline
`framework-rules.md` sets, where the parser does the string surgery and
the rules only join. `Fn::FindInMap` and `Fn::ImportValue` are not graph
problems at all and stay opaque.

`Fn::If` and resource conditions are the case where the rule form is
weaker than code. Emitting both branches as `alternative` edges
over-approximates. That is the safe direction for discovery, since both
handlers get found, and the wrong direction for a contract check, since
an env var declared only in one branch would read as always declared.
The corpus has 46 conditional values and 10 conditioned resources, so
the exposure is small, and the answer is to carry `guardedValue` through
to the finding rather than to build separate machinery. It is a known
soft spot, not a solved one.

**Would a smaller change get most of the value?** Following nested
stacks inside the existing reader is contained: open each
`AWS::CloudFormation::Stack`, resolve its `TemplateURL` relative to the
parent, and index the children too. All nine children in that monorepo
are relative paths (`./x-template.yaml`), so no S3 URL handling is
needed. That alone recovers all 122 missing handlers, which is the whole
of the largest measured gap.

It does not touch the env var scoping, which the deployable-unit fix
addresses separately, and it does not move the queue findings, because
those need the rule-to-queue edge. So the contained fix captures one of
three measured problems, and it is the biggest one. That is a serious
argument for ranking this proposal below the contained fixes, and the
recommendation below takes it.

## The deploy tool already resolves these references

CloudFormation resolves refs itself, `sam build` writes a packaged
template, and `terraform show -json` hands back a resolved graph
including the intrinsics we will never match. Consuming that artifact is
strictly more accurate where it exists, so the question is which layer
owns resolution.

The measured answer is that the static path loses almost nothing suss
reads. Of 4,021 references in the corpus, 2,122 do not resolve
statically, and 2,115 of those name a template parameter, of which 1,660
sit in a root document that nothing above binds. Those are stage names,
memory sizes and account ARNs. Not one of them blocked a fact suss uses:
all 277 handlers, all 220 declared env vars, all 95 queue-to-function
edges and all 46 rule-to-queue edges derived from the source templates
alone. The intrinsics no static reader can evaluate are 18 values.

The artifacts also are not there. That monorepo commits no `.aws-sam`
directory, no `cdk.out` and no Terraform state. `sam build` needs the
SAM CLI and sometimes Docker; `terraform show -json` needs state access
and therefore credentials. suss reads a repo as it sits, with no build
and no credentials, and that promise is what makes it runnable in a
pull request.

So: both, with static as the default and a resolved artifact preferred
when the user points at one. This needs no new mechanism. A packaged SAM
template is a CloudFormation template, and
`suss contract --from cloudformation .aws-sam/build/template.yaml`
already works; the pack needs an option naming a template path, which it
should have anyway. The facts come out the same, because resolution
shortens the chain rather than changing the vocabulary: where the static
path emits `namesTarget` and derives `comesTo` through two hops, the
resolved path emits `isLiteral` and the same downstream rules join
against the same `comesTo`. Nothing downstream can tell which produced
it.

One artifact is out of scope. A description of a deployed stack replaces
logical ids with physical names, which is not the identity boundaries
are keyed on. A packaged SAM template and `terraform show -json` both
keep the graph identity, so both are usable and a live stack is not.

Since the resolved artifact costs 18 values and needs no new machinery,
it does not displace the static work. It is an input option.

## A second format

Terraform sits in the same monorepo, 117 `.tf` files, and suss reads
none of it. Walking it through the vocabulary is the test of whether
these relations are general or CloudFormation's shape wearing a general
name.

- `resource "aws_sqs_queue" "orders" {}` gives `declares` and `hasType`.
- `${aws_sqs_queue.orders.arn}` gives `namesTarget` plus
  `readsAttribute`. The name is spelled differently and means the same
  thing.
- `module "x" { source = "./mod" }` gives `embedsDocument` and
  `bindsParameter`; the module's `variable` blocks give
  `declaresParameter` and its `output` blocks give `publishesOutput`.
  `module.x.arn` then resolves through the same output-chaining rule,
  unchanged.
- `data` sources and `terraform_remote_state` behave like
  `Fn::ImportValue` and stay opaque.

Four of five hold exactly. The one that does not is multiplicity:
`count` and `for_each` turn one declaration into N instances, and
`aws_sqs_queue.orders[0]` is a name this vocabulary cannot express.
CloudFormation has no equivalent, so a second format needs something on
day one that the first never asked for.

That is the argument against building the shared layer now. Name the
relations format-neutrally, which costs nothing beyond word choice, and
put them in a module that does not mention AWS. Do not build a plugin
interface where a pack declares how a reference is written, how a child
document is named and how a parameter is bound, because a Terraform
emitter can emit these relations directly in about as many lines as the
registration protocol would take, and because the first thing it would
need is a relation the interface does not have. Build the interface when
a third format arrives, or when somebody outside this repo wants to add
one.

## Answering the standing questions

1. **Could smaller pieces compose to this?** Yes, and that is the
   design. `comesTo` over `namesTarget` is the only resolution rule
   family; nested stacks, `Fn::Sub` interpolation and `Fn::If`
   alternatives are each one more edge into the same relation, and the
   relay is one join of two derived facts.
2. **Does it reuse what exists?** It runs on `@suss/datalog` unchanged
   and mirrors `@suss/resolution`'s rule shapes. No engine work.
3. **Does it widen shared vocabulary?** It adds a second fact family
   with its own node identity scheme, and reuses one relation name,
   `comesTo`, for the same sentence. The risk is the AWS relations
   drifting back into the neutral set, which is the failure mode
   `framework-rules.md` names. Keeping `hasType` string constants and
   property paths out of the neutral rules is the discipline that
   prevents it.
4. **Is it over-designed, and what is the smallest version that ships a
   measured win?** The whole thing is over-designed as a first step. The
   smallest measured win is following nested stacks in the reader we
   have, worth 122 handlers on one service. The smallest version of this
   design is the neutral relations plus `comesTo`, replacing the six
   `Ref` and `GetAtt` unwrappers, verified by summary equality on the
   existing fixtures.
5. **Naming.** Relations read as sentences stating what is true:
   `declares(d, id, node)`, `namesTarget(d, value, id)`,
   `deliversTo(queue, function)`, `routesInto(rule, queue)`. None of
   them reads as an instruction to the engine.
6. **Verified against code somebody wrote.** Every count here comes from
   the 16 SAM templates in a production serverless monorepo, and the
   rules in this document were run on `@suss/datalog` over facts emitted
   from those files. `runsCode` derived 156 handlers for the service
   where the current reader finds 34, and `reaches` derived 46 relay
   edges on the queue-heavy service.
7. **What it does not do.** It does not evaluate `Fn::FindInMap` or
   `Fn::ImportValue`. It does not decide conditions, so a conditional
   value reads as both branches. It does not reduce a filter pattern to
   a predicate, which is JSON work in extraction and a comparison the
   rules cannot express. It does not read Terraform, Kubernetes or
   compose, and it does not add a plugin interface for them. It does not
   change any summary shape, so it settles no question about what a
   boundary is keyed on.

## Which open items this touches

**Modelling the rule relay:** this supplies the mechanism, `reaches`
from `routesInto` and `deliversTo`, and leaves the decision alone. Whether a
queue is the boundary key is a summary-shape question this does not
answer.

**Stopping the code side claiming boundary participation:** this leaves
it alone. That is a pack change, and this design supports the reasoning behind it
without doing any of it.

**Reading message filters as part of a consumer's input set:** this gets
part of the way. `property(node, "FilterCriteria.Filters[0].Pattern", text)` arrives for
free, and reducing that JSON string to a predicate stays in extraction.
Comparing predicates is not a join.

**Following nested stacks:** this subsumes it entirely, and it is also
the contained fix that should ship first.

## Recommendation

Rank this below the two contained fixes, and sequence it so each step is
measurable on its own.

1. **Follow nested stacks in the reader we have.** Resolve each
   `AWS::CloudFormation::Stack` `TemplateURL` relative to its parent and
   index the children. Measured on that monorepo, handler discovery on
   the largest service goes from 34 to 156. Report a named file when a
   child is missing, which that repo already needs. This is the first
   step and it is worth doing whatever happens to the rest.
2. **Land the deployable-unit fix** already in flight, which takes the
   1,874 false errors down by keying on the function rather than the
   path.
3. **Then the neutral relations plus `comesTo`**, replacing the six
   `Ref` and `GetAtt` unwrappers and the three `normalizeCodeUri`
   copies, with output equality on the existing fixtures as the
   acceptance bar. Nothing user-visible changes, which is what makes it
   safe to measure.
4. **Then `deliversTo`, `routesInto` and `reaches`**, which is what lets
   the channel rewrite and the last of the path scoping go, and which is
   the step the queue findings need.

Step 1 is the one to start on. It is a day of work, it captures the
largest measured gap on its own, and the number it moves is countable
before anything else is decided.
