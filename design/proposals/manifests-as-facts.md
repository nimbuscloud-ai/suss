# Reading deploy manifests as facts

Status: draft, seeking alignment. Nothing implemented.

Evidence comes from running a prototype emitter and the rules below over
the SAM templates of a production serverless monorepo. Measurements are
proportions rather than counts, since the counts belong to the company
that runs those templates.

## The problem

A deploy template is a graph of resources joined by names. `Ref` points
at a resource, `GetAtt` points at one and reads an attribute off it, and
a nested stack passes parameters down and hands outputs back up.
Following a name to what it eventually means is the problem `comesTo`
already solves for TypeScript values, and `@suss/resolution` already has
rules for that pattern: a name binds to a value, an import chains to an
export, a re-export chains again.

We wrote a bespoke walker for templates instead. Four measured gaps are
places that walker stops.

**Only the root document is read.** The aws-lambda pack walks up from a
source file to the nearest `template.yaml` and parses that one file. In
the largest service I measured, the pack finds the handlers declared in
the root document and none of the ones declared in its children, which
is most of the service, because a child is reached through
`AWS::CloudFormation::Stack` and nothing follows that edge.

**The runtime-config check pairs every read against every function.** It
scopes a handler's `process.env.X` read to a Lambda by a `startsWith`
prefix match on the file path. Every function declared in a template
shares one deployment path with the others, so a path prefix separates
nothing, and every read in a service pairs against every function's
contract. The false errors that come out of that are the product of the
reads and the functions rather than the sum, so the worse the service's
sharing, the worse the noise.

**The SAM `Globals` section is invisible.** A template declares
environment variables once for every function it contains, under
`Globals.Function.Environment.Variables`, and the reader looks only at
`Properties.Environment.Variables`. Every variable declared that way
looks undeclared.

**Queue findings did not move** when handler discovery on a service went
from nothing to every handler in the root document. Consumer orphans and
unused producers both stayed where they were, because those findings are
about wiring the walker reads separately from handlers.

## What the templates actually contain

The proportions that make the argument describe CloudFormation as a
format rather than anyone's stack.

References dominate. Counting `Ref`, `Fn::GetAtt` and the substitution
tokens inside `Fn::Sub`, references outnumber resources by roughly four
to one in the templates I measured. Following names is most of what
reading a template is.

The intrinsics no static reader can evaluate are rare. `Fn::FindInMap`
and `Fn::ImportValue` together account for fewer than a fifth of a
percent of leaf property values. Conditional values, meaning `Fn::If`
and resources with a `Condition`, are also well under one percent.
A resource has something like nine leaf property values on average,
so the fact base is a small multiple of the document.

## The design

### Two layers, and where the line falls

The TypeScript adapter owns the language and a framework pack declares
what a library means on top of it. Manifests have no equivalent layer
today, so `@suss/manifest-aws` and `@suss/contract-cloudformation` mix
both jobs in one file. Apply the same test and the split is clear.

CloudFormation's own semantics are that a document declares named
resources, a value can point at one of them, a value can read an
attribute off the thing it points at, a document declares parameters and
publishes outputs, and a resource can embed another document. None of
that mentions AWS.

What AWS means is that `AWS::Serverless::Function` runs the code a
`Handler` string points at, that an event source mapping wires a queue
to a function, and that an `AWS::Events::Rule` routes a subject into its
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
output continues at what the child published. Both work the same way the
import rules already do.

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
produce, and today the key is a path prefix, which is why it fails.

    declaresEnvVar(fn, name) :- hasType(fn, "AWS::Serverless::Function"),
                                envVarProperty(fn, name).

    declaresEnvVar(fn, name) :- hasType(fn, "AWS::Serverless::Function"),
                                declares(d, _, fn),
                                globalEnvVarProperty(d, name).

    runsCode(fn, handler)    :- hasType(fn, "AWS::Serverless::Function"),
                                property(fn, "Handler", handler).

`runsCode` gives the module and export each function points at, so the
adapter already knows which function a summary belongs to when it
discovers the unit. The read then joins on the function node, and the
path never appears. Two Lambdas on one CodeUri are two different nodes
and share nothing.

The second `declaresEnvVar` rule is the `Globals` gap. A document-level
default is one more way for a name to arrive at a function, so it is one
more rule into a relation that already exists, and every rule downstream
of `declaresEnvVar` picks it up without being touched.

#### What the deployable-unit fix already showed

The tactical version of this is #54, and what turned up while measuring
that fix strengthens the case for the fact form rather than removing it.

The mechanism was the path normalizer. A template writing `CodeUri: ./`
normalizes to the empty string, and every path starts with the empty
string, so every function's environment was compared against every
function's reads. A template writing `CodeUri: .` normalizes to a single
dot, which no project-relative path starts with, so a service written
that way paired nothing at all and reported nothing. Same bug, one
convention loud and the other silent, and neither symptom points at the
normalizer that causes it.

That fix stamps the function's identity on the summary and compares
identities, keeping the path as a fallback for code that does not say
which unit it belongs to. This design supplies the identity from the
template side as a fact rather than as a stamped field, and deletes the
fallback. So the tactical fix survives, and this replaces the fallback
it leaves behind, which is the part that would otherwise keep the prefix
match alive forever.

Opening the findings that survived that fix is also what turned up the
`Globals` gap above.

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
channel the code spells out, which is usually an env var name. It cannot
know its own function's logical id, which env vars are provided, which
queue is attached, or what subject arrives.

The template side knows all the wiring, and it knows the module path and
export name each function points at. It cannot know what the code does
with any of it.

So the deployed function is a key both sides can produce, and only
because the template hands it over through `runsCode`. The channel is
not. The code gives an env var name, and only the template says what
that env var contains, which is why `envVarTargets` exists as a metadata
bridge today. Under this design that bridge becomes a join:

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
that produced the evidence in this document is 120) plus a dozen rules.
Net deletion is around 350 lines, and the drift between the six
unwrappers and the three path conventions stops being possible rather
than being fixed.

Special-casing for `Ref` and `GetAtt` does not survive anywhere. What
survives is `Fn::FindInMap` and `Fn::ImportValue` as `opaqueValue`,
which is the fraction of a percent of values noted above.

## Risks

**Error reporting.** A relation has no file or line unless the facts
have one, so `locatedAt` has to be emitted and every finding has to join
against it. Two measured cases need this. A child document is referenced
by a `TemplateURL` and is not on disk, so a stack resource resolves to
no file at all. And a handful of names in the corpus point at nothing
declared in their document. Neither is reportable today, because every
summary the CloudFormation reader emits has
`range: { start: 1, end: 1 }`. The YAML parser gives node ranges, so the
fact form makes this better rather than worse, but only if `locatedAt`
lands with the first relation rather than later.

**Cost.** These timings come from running it. Emitting the facts for
every document in that corpus took 232ms, and evaluating the rules over
them took 162ms. Against that, extracting one small service with
`--no-cache` takes 4.21s. So the
manifest side is a few percent of a run, and the fact base for a whole
multi-service corpus is small enough to keep in memory without thinking
about it.

Scaling: `property` is linear in leaf values, so linear in resources at
the ratio above. `comesTo` came out at roughly one derived fact for
every two references, so it is linear in references in practice because
the chains are shallow. The join that could misbehave is the
output-chaining rule, which pairs every stack against every output of
its child. The nesting in this corpus is shallow and the outputs are few
enough that it never bit, and deep nesting with wide outputs is the case
that would. That is worth a guard rail rather than an assumption.

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
an env var declared in only one branch would look as though it is always
declared. Conditional values are under a percent of the corpus, so the
exposure is small, and the answer is to carry `guardedValue` through to
the finding rather than to build separate machinery. It is a known soft
spot, not a solved one.

**Would a smaller change get most of the value?** Following nested
stacks inside the existing reader is contained: open each
`AWS::CloudFormation::Stack`, resolve its `TemplateURL` relative to the
parent, and index the children too. Every child in that monorepo is a
relative path (`./x-template.yaml`), so no S3 URL handling is needed.
That alone recovers every handler in the largest measured gap.

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
reads. About half the references in the corpus do not resolve
statically, and nearly every one of those points at a template
parameter, most of them in a root document that nothing above binds.
Those are stage names, memory sizes and account ARNs. Not one of them
blocked a fact suss uses: every handler, every declared env var, every
queue-to-function edge and every rule-to-queue edge derived from the
source templates alone. What no static reader can evaluate stays the
fraction of a percent noted above.

The artifacts also are not there. That monorepo commits no `.aws-sam`
directory, no `cdk.out` and no Terraform state. `sam build` needs the
SAM CLI and sometimes Docker; `terraform show -json` needs state access
and therefore credentials. suss reads a repo as it is, with no build
and no credentials, and that promise is what makes it runnable in a
pull request.

So: both, with static as the default and a resolved artifact preferred
when the user points at one. This needs no new mechanism. A packaged SAM
template is a CloudFormation template, and
`suss contract --from cloudformation .aws-sam/build/template.yaml`
already works; the pack needs an option that gives a template path,
which it should have anyway. The facts come out the same, because
resolution shortens the chain rather than changing the vocabulary: where
the static path emits `namesTarget` and derives `comesTo` through two
hops, the resolved path emits `isLiteral` and the same downstream rules
join against the same `comesTo`. Nothing downstream can tell which
produced it.

One artifact is out of scope. A description of a deployed stack replaces
logical ids with physical names, which is not the identity boundaries
are keyed on. A packaged SAM template and `terraform show -json` both
keep the graph identity, so both are usable and a live stack is not.

Since the resolved artifact costs so little and needs no new machinery,
it does not displace the static work. It is an input option.

## A second format

Terraform lives in the same monorepo, and suss reads none of it. Walking
it through the vocabulary is the test of whether these relations are
general or CloudFormation's own structure wearing a general name.

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

Four of the five match exactly. The one that does not is multiplicity:
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
   and mirrors `@suss/resolution`'s rule forms. No engine work.
3. **Does it widen shared vocabulary?** It adds a second fact family
   with its own node identity scheme, and reuses one relation name,
   `comesTo`, for the same sentence. The risk is the AWS relations
   drifting back into the neutral set, which is the failure mode
   `framework-rules.md` describes. Keeping `hasType` string constants
   and property paths out of the neutral rules is the discipline that
   prevents it.
4. **Is it over-designed, and what is the smallest version that ships a
   measured win?** The whole thing is over-designed as a first step. The
   smallest measured win is following nested stacks in the reader we
   have. The smallest version of this design is the neutral relations
   plus `comesTo`, replacing the six `Ref` and `GetAtt` unwrappers,
   verified by summary equality on the existing fixtures.
5. **Naming.** Relations are written as sentences stating what is true:
   `declares(d, id, node)`, `namesTarget(d, value, id)`,
   `deliversTo(queue, function)`, `routesInto(rule, queue)`. None of
   them sounds like an instruction to the engine.
6. **Verified against code somebody wrote.** We ran the rules in this
   document on `@suss/datalog` over facts emitted from the SAM templates
   of a production serverless monorepo. `runsCode` derived every handler
   in a service where the current reader finds only the ones in the root
   template, and `reaches` derived the full set of relay edges on the
   queue-heavy service, where the reader derives none.
7. **What it does not do.** It does not evaluate `Fn::FindInMap` or
   `Fn::ImportValue`. It does not decide conditions, so a conditional
   value is treated as both branches. It does not reduce a filter
   pattern to a predicate, which is JSON work in extraction and a
   comparison the rules cannot express. It does not read Terraform,
   Kubernetes or compose, and it does not add a plugin interface for
   them. It does not change how any summary is structured, so it settles
   no question about what a boundary is keyed on.

## Which open items this touches

**Modelling the rule relay:** this supplies the mechanism, `reaches`
from `routesInto` and `deliversTo`, and leaves the decision alone.
Whether a queue is the boundary key is a question about how a summary is
structured, and this does not answer it.

**Stopping the code side claiming boundary participation:** this leaves
it alone. That is a pack change, and this design supports the reasoning
behind it without doing any of it.

**Reading message filters as part of a consumer's input set:** this gets
part of the way. `property(node, "FilterCriteria.Filters[0].Pattern",
text)` arrives for free, and reducing that JSON string to a predicate
stays in extraction. Comparing predicates is not a join.

**Following nested stacks:** this subsumes it entirely, and it is also
the contained fix that should ship first.

## Recommendation

Rank this below the two contained fixes, and sequence it so each step is
measurable on its own.

1. **Follow nested stacks in the reader we have.** Resolve each
   `AWS::CloudFormation::Stack` `TemplateURL` relative to its parent and
   index the children. Measured on that monorepo, handler discovery on
   the largest service goes from the root document's share to all of
   them. Report the file name when a child is missing, which that repo
   already needs. This is the first step and it is worth doing whatever
   happens to the rest.
2. **Land the deployable-unit fix** in #54, which keys the pairing on
   the function rather than the path and takes out the bulk of the false
   runtime-config errors.
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
