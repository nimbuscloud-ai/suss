# Dependency stubs

Some packages resist reading. A napi-rs crate compiles to a binary before npm ever sees it. A private wrapper ships only its build output. Extraction follows a call to their exports and stops at a boundary it cannot see across, so the queue the wrapper publishes to, or the routes the helper registers, never reach a summary.

A dependency stub states those facts in a file the repo checks in. Extraction reads it before the packs run and treats each statement as if the package's source had said it.

```yaml
# suss/stubs/acme-ledger-native.yaml
package: "@acme/ledger-native"
authored: agent
from: crate source at 1.4.2
statements:
  - kind: performs-call
    export: publishEntry
    system: aws.sqs
    spec: { subject: { at: 0 }, payload: { at: 1 } }
```

With that in place, every call to `publishEntry(queue, body)` anywhere in the project reads as a send to the queue its first argument says, and `suss ask 'what writes aws.sqs:ledger-queue'` lists the callers.

## The file

Stub files live in `suss/stubs/` at the project root, one file per package. YAML and JSON both parse, one schema, chosen by extension; YAML is the authoring default because draft blanks and provenance notes are comments.

Each file has a `package`, optional provenance (`authored`, who wrote it; `from`, what they read), and one or more statements:

| kind | states | example |
|---|---|---|
| `performs-call` | an export calls into a system | `publishEntry` sends to SQS, subject in argument 0 |
| `composes-decorator` | an export wraps a known decorator | `ApiController` composes `@nestjs/common` `Controller` |
| `registers-routes` | an export mounts routes on the app it is passed | `mountHealth` registers `GET /health` |
| `re-exports` | the package re-exports a framework | an internal wrapper around FastAPI |
| `extends-base` | a class extends a framework base | a shared GraphQL resolver base |

`performs-call` systems today: `aws.sqs`, `aws.events`, `aws.dynamodb`, `aws.lambda`, `axios`. The `spec` fields are the same ones the matching pack option took, so anything an option could state, a statement can.

A stub is provided by the project today. The direction is package-shipped stubs, referenced from `package.json` the way `types` points at declarations, so a consumer configures nothing; the loader gains a second place to look and the format does not change.

## Drafting one

```
$ suss infer stub @acme/ledger-native
Drafted suss/stubs/acme-ledger-native.yaml: 3 exports from 3 call sites.
```

The draft is built from what the project already shows: every call into the package, grouped by export, with the argument shapes observed at each site as comments. The semantic blanks are what the code cannot say, which system a call reaches and which argument means what:

```yaml
statements:
  # publishEntry: 3 calls
  #   src/ledger.ts:42  (config.queueUrl, entry)
  - kind: performs-call
    export: "publishEntry"
    system: ""  # what the call reaches: aws.sqs, aws.events, aws.dynamodb, aws.lambda, axios
    spec: {}  # argument meanings, e.g. { subject: { at: 0 }, payload: { at: 1 } }
```

Filling the blanks takes the package's own source. That is a job for whoever can read it, and an agent usually can, a Rust crate included: draft from the evidence, read the dependency, fill the semantics, record the provenance, commit. MCP hosts get the same skeleton from the `suss_stub_draft` tool. `-o -` prints the draft instead of writing it.

The loader compares the version in a stub's `from:` line against the installed package and prints one line when they differ, so a stub written against 1.2.0 gets re-checked when the project moves to 1.4.2.

## The options stubs replaced

Nine pack options stated dependency facts before stubs existed: `classDecorators` on the NestJS packs, `producers` on aws-sqs and aws-eventbridge, `factories` on axios, `wrapperModules` on fastapi and flask-restx, and `baseClassNames` on graphql-ruby.

0.20.0 routed them through stubs and printed a pointer for a project still configuring one. 0.21.0 removed them, so a pack config setting one stops the run and says which stub kind takes it over. The difference is more than location: an option configures one pack, while a stub states the fact once and every pack that consumes it is fed, hand-written entries first.

The stub statement feeds the pack through the same option key, which is why a pack still declares it. What went away is your config file setting it.

Three options were listed alongside those nine when stubs shipped, and they stay in pack config: `registrationHelpers` on express, fastify and hono, `requestFunctions` on aws-dynamodb, and `subjectFactories` on aws-lambda. Each describes a function the project wrote itself, which is the case the section below says a stub is not for. A stub is keyed by a package, so it cannot spell a helper reached by a relative import at all.

Editing a stub invalidates the extraction cache the same way editing pack config does.

## What a stub is not

- Not type information; `.d.ts` files already state that.
- Not for first-party code, which extraction reads directly.
- Not verified yet: a statement is a claim with its provenance attached. Checking claims against readable package sources is designed but not built, which is why `authored` and `from` are worth filling in.
