# Proposal: boundaries whose behaviour lives outside the code we read

Status: draft, seeking alignment. Nothing here is implemented. These
gaps came from running the Next.js pack against two production apps and
an open-source storefront.

## The problem

Four things came back wrong or missing, and they are not four
problems.

1. **A route a library serves.** NextAuth's route file is
   `export { GET, POST } from "@/auth"`, where those names come out of
   destructuring what `NextAuth(config)` returned. Discovery finds the
   file, finds the export names, and finds no function in the project
   to read. Nothing is reported, so a reader sees a hole and cannot
   tell whether discovery missed the route or the route is not there.

2. **A response type a library defines.** A handler ending in
   `new ImageResponse(...)` from `next/og`, or
   `new StreamingTextResponse(stream)` from `ai`, matches no terminal
   any pack describes. The unread return is now reported, which is the
   correct floor, and the handler still says nothing about what it
   produces.

3. **An operation that lives in data rather than syntax.** The storefront
   sends every query and mutation through its own `executeGraphQL`,
   which takes a document and ends at `fetch`. Two client units stand
   in for the whole data layer. The operation name, the variables, and
   the selected fields are all in the project, in `.graphql` files, and
   none of them reach a summary.

4. **A handler that serves more than one method.** A `pages/api`
   handler is one default export that switches on `req.method`. The
   REST binding has room for a single method, so the pack reports the
   path and leaves the method blank, and the handler pairs with nothing.

## What the first three have in common

Each one is a boundary the project does have, where the thing that
would describe it is outside the function suss is reading. In 1 it is
inside a dependency. In 2 the words for the outcome belong to a
dependency. In 3 it is in a file next to the code rather than in it.

Three different fixes would be three different mistakes, because we
already have the one mechanism that covers all of them.

A contract source produces `BehavioralSummary` values from a
declaration rather than from a function body. `@suss/contract-openapi`
reads a spec, `@suss/contract-cloudformation` reads a template,
`@suss/contract-appsync` reads a schema, and each stamps
`confidence: { source: "declared" }` or `"derived"` on what it emits.
The checker pairs those against code-derived summaries on boundary
identity and does not care which side came from where. That is the
whole point of having one summary format.

So the question is where the description comes from when no spec file
exists, rather than how to describe a boundary nothing implements.

## What is missing

**A declaration a person or a library can write.** Today a contract
source has to read some other tool's artifact. The three cases above
have no artifact to read, and the fact is knowable and stable.
NextAuth's handler serves GET and POST wherever it is mounted.
`ImageResponse` is a 200 with an image in it. `executeGraphQL` takes the
document at argument 0.

We settled the name for this already, in the note saying that renaming
`@suss/stub-*` to `@suss/contract-*` frees "stub" for interface
declarations a person can write by hand. Today's gaps are the demand
for it.

Two places the same declaration can come from:

- **In the project.** A file the config points at, for the cases
  specific to how this project is put together, and for anything a
  library has not shipped yet.
- **From the library.** A package ships its own declaration the way it
  ships its types, and installing it is enough. This is where the
  package-exports work already points: a package's exports are a
  boundary, and a provider publishes summaries alongside the code.

The second is the leverage and the first is the way to get there. A
declaration someone wrote by hand, and that works, is what makes a
library author willing to adopt it, and it costs nothing to keep
supporting.

**Marking what is declared rather than read.** `confidence.source`
already has `declared`, and today's change to mark an empty summary
`low` means you can tell an unread handler from a declared one, and
both from one suss read. A declared summary should not
claim it was derived from the body, and a reader should be able to ask
which of their boundaries are described by hand.

## The fourth one is a different thing

A handler that serves a set of methods is not a reading problem. The
model has one method per REST binding, and `pages/api`
serves all of them. Express has the same situation with `app.all`, and
API Gateway with `ANY`, which the Lambda pack handles today by refusing
to bind such a function as a route.

There are three options, none of them free: a method set on the
binding, a synthetic unit per method the handler branches on, or
leaving it as it is and saying so. The second is closest to how the
rest of the model works, since a handler that branches on `req.method` already has the branch
conditions extracted, and each branch is a path with its own outcome.
That would let a `pages/api` handler pair method by method with the
clients calling it.

We should decide this separately from the rest of this, and decide it
before the pack claims to cover the pages router.

## Order

1. The declaration format, driven by the three cases above rather than
   designed in the abstract. Start with the NextAuth one, since it is
   the smallest: a boundary, a method, and no behaviour claimed.
2. The response-type case next, because it is the one a library author
   would most plausibly ship, and because it is the same file format
   pointed at a different question.
3. The GraphQL documents, which need the declaration to say "argument 0
   is the operation" and then need the reader that finds the document.
   The largest of the three and the one with the most behind it.
4. Method sets, on their own, after deciding which of the three options
   is right.
