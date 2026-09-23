# Reading deploy manifests as facts

Status: draft, seeking alignment. Nothing implemented.

The evidence comes from running a prototype emitter and the rules below
over the SAM templates of a production serverless monorepo. The
measurements are given as proportions, because the counts belong to the
company that runs those templates.

## The problem

A deploy template is a graph of resources joined by names. `Ref` points
at a resource, `GetAtt` points at one and reads an attribute off it, and
a nested stack passes parameters down and hands outputs back up.
`comesTo` already follows a TypeScript name to what it eventually means,
and `@suss/resolution` already has rules for that pattern: a name binds
to a value, an import chains to an export, a re-export chains again.

Instead, we wrote a separate walker for templates. Each of the four
measured gaps below is a place where that walker stops.

**Only the root document is read.** The aws-lambda pack walks up from a
source file to the nearest `template.yaml` and parses that one file. In
the largest service I measured, the pack finds the handlers declared in
the root document and none of the ones declared in its children, which
is most of the service. A child is reached through
`AWS::CloudFormation::Stack`, and nothing follows that edge.

**The runtime-config check pairs every read against every function.** It
scopes a handler's `process.env.X` read to a Lambda by a `startsWith`
prefix match on the file path. Every function declared in a template
shares one deployment path with the others, so a path prefix separates
nothing, and every read in a service pairs against every function's
contract. The false errors grow with the number of reads times the
number of functions, so the more a service shares, the more noise it
gets.

**The SAM `Globals` section is invisible.** A template declares
environment variables once for every function it contains, under
`Globals.Function.Environment.Variables`, and the reader looks only at
`Properties.Environment.Variables`. Every variable declared that way
looks undeclared.

**Queue findings did not move** when handler discovery on a service went
from nothing to every handler in the root document. Consumer orphans and
unused producers both stayed where they were, because those findings are
about wiring that the walker reads separately from handlers.

## What the templates actually contain

The proportions that matter here describe CloudFormation as a format,
and they reveal nothing about anyone's stack.

References dominate. Counting `Ref`, `Fn::GetAtt` and the substitution
tokens inside `Fn::Sub`, references outnumber resources by roughly four
to one in the templates I measured. Most of the work of reading a
template is following names.

The intrinsics no static reader can evaluate are rare. `Fn::FindInMap`
and `Fn::ImportValue` together account for fewer than a fifth of a
percent of leaf property values. Conditional values, meaning `Fn::If`
and resources with a `Condition`, are also well under one percent.
A resource has something like nine leaf property values on average,
so the fact base is a small multiple of the document.

## The design

### Two layers, and where the line falls

For TypeScript, the adapter handles the language and a framework pack
declares what a library means on top of it. Manifests have no such
split today, so `@suss/manifest-aws` and `@suss/contract-cloudformation`
mix both jobs in one file. The same test separates them.

CloudFormation itself defines a small set of things. A document
declares named resources. A value can point at one of them, and can
read an attribute off the thing it points at. A document declares
parameters and publishes outputs, and a resource can embed another
document. None of that mentions AWS.

The AWS meaning comes on top: `AWS::Serverless::Function` runs the code
a `Handler` string points at, an event source mapping wires a queue to
a function, and an `AWS::Events::Rule` routes a subject into its
targets. That meaning belongs to one technology, so it goes in a pack.

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

The neutral side has one derived relation, `comesTo(name, node)`, which
follows a name to what it arrives at. `@suss/resolution` uses the same
name for the same idea. Manifest node identity is `document#logicalId`
and code node identity is `file:start-end`, so the two never collide.
The rules still go in separate modules, since the two are sibling rule
sets that do not share rules.

### Nested stacks

A reference into a child document's parameter continues at whatever the
parent bound to that parameter. A reference to a child stack's output
continues at what the child published. Both work the same way the
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

These rules match the import rules one for one. A document is a module,
a parameter is an import, an output is an export, and `bindsParameter`
plays the part `exportsAs` plays in the other direction. Recursion
through `comesTo` handles any nesting depth, so a grandchild needs no
new rule. None of this needs a new mechanism.

### Env var scoping

The code side reads `process.env.X` somewhere in a file. The template
side declares X on a function. Joining them needs a key both sides can
produce. Today the key is a path prefix, and that is why the join
fails.

    declaresEnvVar(fn, name) :- hasType(fn, "AWS::Serverless::Function"),
                                envVarProperty(fn, name).

    declaresEnvVar(fn, name) :- hasType(fn, "AWS::Serverless::Function"),
                                declares(d, _, fn),
                                globalEnvVarProperty(d, name).

    runsCode(fn, handler)    :- hasType(fn, "AWS::Serverless::Function"),
                                property(fn, "Handler", handler).

`runsCode` gives the module and export each function points at, so when
the adapter discovers a unit it can already tell which function the
summary belongs to. The read then joins on the function node, and the
path never comes into it. Two Lambdas on one CodeUri are two different
nodes and share nothing.

The second `declaresEnvVar` rule closes the `Globals` gap. A
document-level default is one more way for a name to arrive at a
function, so it adds one rule to a relation that already exists. Every
rule downstream of `declaresEnvVar` picks it up with no change.

#### What the deployable-unit fix already showed

#54 is the tactical version of this. What turned up while measuring
that fix makes the case for the fact form stronger.

The cause was the path normalizer. A template writing `CodeUri: ./`
normalizes to the empty string, and every path starts with the empty
string, so every function's environment was compared against every
function's reads. A template writing `CodeUri: .` normalizes to a single
dot, which no project-relative path starts with, so a service written
that way paired nothing at all and reported nothing. It is one bug. One
convention makes it loud and the other makes it silent, and neither
symptom points at the normalizer.

That fix stamps the function's identity on the summary and compares
identities. It keeps the path as a fallback for code that does not
state which unit it belongs to. This design gets the identity from the
template side as a fact instead of a stamped field, and deletes the
fallback. The tactical fix stays. This design replaces only the
fallback it leaves behind, and without this design that fallback would
keep the prefix match in the code for good.

The `Globals` gap above also turned up while going through the findings
that survived that fix.

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
rewrite in `buildLambdaConsumerSummary` exists because nothing records
the edge from a rule to the queue it feeds. To keep the pairing from
reporting an orphan, the reader forges a subject identity onto the
consumer. Once `routesInto` is a fact the rewrite has nothing left to
do, and `buildQueueSubjectMap` and `singleRoutedSubjectOf` go with it.
The message-bus-identity proposal asks for this mechanism, and here it
comes as a join with no new machinery.

### What each side can know alone

With no template, the code side can see that a module exports a
function, that a value is read from `process.env.X`, and that a call
sends to a channel the code spells out, which is usually an env var
name. It cannot see its own function's logical id, which env vars are
provided, which queue is attached, or what subject arrives.

The template side can see all the wiring, including the module path
and export name each function points at. It cannot see what the code
does with any of it.

So both sides can produce the deployed function as a key, but only
because the template provides it through `runsCode`. Neither side can
produce the channel alone. The code gives an env var name, and only the
template records what that env var contains. That gap is why
`envVarTargets` exists today as a metadata bridge. Under this design
the bridge becomes a join:

    configures(fn, name, target) :- declaresEnvVar(fn, name),
                                    envVarProperty(fn, name),
                                    property(fn, path, value),
                                    comesTo(value, target).

A value that one side can never construct cannot serve as a key. The
message-bus-identity proposal gives the same reason for taking the
boundary binding off the code side.

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
whatever was authored, with a comment explaining that the checker's
prefix match depends on it. All three go when the prefix match goes.

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
The net deletion is around 350 lines. The six unwrappers and the three
path conventions can no longer drift apart, because they no longer
exist.

No special case for `Ref` or `GetAtt` is left anywhere. Only
`Fn::FindInMap` and `Fn::ImportValue` remain, as `opaqueValue`, and they
are the fraction of a percent of values noted above.

## Risks

**Error reporting.** A relation has no file or line unless the facts
have one, so `locatedAt` has to be emitted and every finding has to join
against it. Two measured cases need this. A child document is referenced
by a `TemplateURL` and is not on disk, so a stack resource resolves to
no file at all. And a handful of names in the corpus point at nothing
declared in their document. Neither is reportable today, because every
summary the CloudFormation reader emits has
`range: { start: 1, end: 1 }`. The YAML parser gives node ranges, so the
fact form improves this, but only if `locatedAt` lands with the first
relation instead of later.

**Cost.** These timings come from running it. Emitting the facts for
every document in that corpus took 232ms, and evaluating the rules over
them took 162ms. Against that, extracting one small service with
`--no-cache` takes 4.21s. So the
manifest side is a few percent of a run, and the fact base for a whole
multi-service corpus is small enough to keep in memory with no special
handling.

Scaling: `property` is linear in leaf values, so linear in resources at
the ratio above. `comesTo` came out at roughly one derived fact for
every two references, so it is linear in references in practice because
the chains are shallow. The join that could misbehave is the
output-chaining rule, which pairs every stack against every output of
its child. In this corpus the nesting is shallow and the outputs are
few, so it never caused trouble. Deep nesting with many outputs would.
That case should get a guard rail instead of an assumption.

**What is not a graph problem.** `Fn::Sub` with inline substitution is
string work, and it stays in extraction: tokenize the string and emit
one `interpolates` edge per `${}`. That follows the discipline
`framework-rules.md` sets, where the parser does the string surgery and
the rules only join. `Fn::FindInMap` and `Fn::ImportValue` are not graph
problems at all and stay opaque.

`Fn::If` and resource conditions are the case where the rule form is
weaker than code. Emitting both branches as `alternative` edges
over-approximates. For discovery that is the safe direction, since both
handlers get found. For a contract check it is the wrong direction,
since an env var declared in only one branch would look as though it is
always declared. Conditional values are under a percent of the corpus,
so the exposure is small. The answer is to carry `guardedValue` through
to the finding instead of building separate machinery. It is a known
weak spot, and it stays unsolved.

**Would a smaller change get most of the value?** Following nested
stacks inside the existing reader is a contained change: open each
`AWS::CloudFormation::Stack`, resolve its `TemplateURL` relative to the
parent, and index the children too. Every child in that monorepo is a
relative path (`./x-template.yaml`), so no S3 URL handling is needed.
That alone recovers every handler in the largest measured gap.

It does not touch the env var scoping, which the deployable-unit fix
addresses separately. It does not move the queue findings either,
because those need the rule-to-queue edge. So the contained fix handles
one of three measured problems, and it is the biggest one. That is a
serious argument for ranking this proposal below the contained fixes,
and the recommendation below does rank it there.

## The deploy tool already resolves these references

CloudFormation resolves refs itself, `sam build` writes a packaged
template, and `terraform show -json` hands back a resolved graph
including the intrinsics we will never match. Where that artifact
exists, consuming it is strictly more accurate. So the question is which
layer should do the resolving.

Measured, the static path loses almost nothing suss reads. About half
the references in the corpus do not resolve statically, and nearly
every one of those points at a template parameter, most of them in a
root document that nothing above binds. Those are stage names, memory
sizes and account ARNs. Not one of them blocked a fact suss uses. Every
handler, every declared env var, every queue-to-function edge and every
rule-to-queue edge came from the source templates alone. What no static
reader can evaluate stays the fraction of a percent noted above.

The artifacts are also missing. That monorepo commits no `.aws-sam`
directory, no `cdk.out` and no Terraform state. `sam build` needs the
SAM CLI and sometimes Docker; `terraform show -json` needs state access
and therefore credentials. suss reads a repo as it is, with no build
and no credentials, and that is what lets it run on a pull request.

So suss should do both. It reads the source templates by default, and
prefers a resolved artifact when the user points at one. This needs no
new mechanism. A packaged SAM template is a CloudFormation template, and
`suss contract --from cloudformation .aws-sam/build/template.yaml`
already works; the pack needs an option that gives a template path,
which it should have anyway. The facts come out the same, because
resolution shortens the chain and leaves the vocabulary alone. Where the
static path emits `namesTarget` and derives `comesTo` through two hops,
the resolved path emits `isLiteral`, and the same downstream rules join
against the same `comesTo`. Nothing downstream can tell which path
produced it.

One artifact is out of scope. A description of a deployed stack replaces
logical ids with physical names, and boundaries are keyed on the
logical ids. A packaged SAM template and `terraform show -json` both
keep the graph identity, so both are usable and a live stack is not.

The resolved artifact costs little and needs no new machinery, so it
becomes one more input option. The static work is still needed.

## A second format

Terraform lives in the same monorepo, and suss reads none of it. Mapping
Terraform onto the vocabulary tests whether these relations are general,
or whether they are CloudFormation's own structure under a general name.

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

For that reason the shared layer should not be built now. Name the
relations format-neutrally, which costs nothing beyond word choice, and
put them in a module that does not mention AWS. Do not build a plugin
interface where a pack declares how a reference is written, how a child
document is named and how a parameter is bound. A Terraform emitter can
emit these relations directly in about as many lines as the
registration protocol would take. And the first thing that emitter
would need is a relation the interface does not have. Build the
interface when a third format arrives, or when somebody outside this
repo wants to add one.

## Answering the standing questions

1. **Could smaller pieces compose to this?** Yes, and the design is
   built that way. `comesTo` over `namesTarget` is the only resolution
   rule family. Nested stacks, `Fn::Sub` interpolation and `Fn::If`
   alternatives each add one more edge into the same relation, and the
   relay is one join of two derived facts.
2. **Does it reuse what exists?** It runs on `@suss/datalog` unchanged
   and mirrors `@suss/resolution`'s rule forms. It needs no engine work.
3. **Does it widen shared vocabulary?** It adds a second fact family
   with its own node identity scheme, and reuses one relation name,
   `comesTo`, for the same meaning. The risk is the AWS relations
   drifting back into the neutral set, which is the failure mode
   `framework-rules.md` describes. Keeping `hasType` string constants
   and property paths out of the neutral rules prevents it.
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
it alone. That is a pack change. This design supports the reasoning
behind it without doing any of the work.

**Reading message filters as part of a consumer's input set:** this gets
part of the way. `property(node, "FilterCriteria.Filters[0].Pattern",
text)` comes with no extra work, and reducing that JSON string to a
predicate stays in extraction. Comparing predicates is not a join.

**Following nested stacks:** this covers it entirely, and it is also
the contained fix that should ship first.

## Recommendation

Rank this below the two contained fixes, and sequence it so each step is
measurable on its own.

1. **Follow nested stacks in the reader we have.** Resolve each
   `AWS::CloudFormation::Stack` `TemplateURL` relative to its parent and
   index the children. Measured on that monorepo, handler discovery on
   the largest service goes from the root document's share to all of
   them. Report the file name when a child is missing, which that repo
   already needs. This is the first step, and it should ship whatever
   happens to the rest.
2. **Land the deployable-unit fix** in #54, which keys the pairing on
   the function instead of the path and removes most of the false
   runtime-config errors.
3. **Then the neutral relations plus `comesTo`**, replacing the six
   `Ref` and `GetAtt` unwrappers and the three `normalizeCodeUri`
   copies, with output equality on the existing fixtures as the
   acceptance bar. Nothing user-visible changes, so it is safe to
   measure.
4. **Then `deliversTo`, `routesInto` and `reaches`.** These let the
   channel rewrite and the last of the path scoping go, and the queue
   findings need this step.

Start with step 1. It is a day of work and captures the largest
measured gap on its own. The number it moves can be counted before
anything else is decided.
