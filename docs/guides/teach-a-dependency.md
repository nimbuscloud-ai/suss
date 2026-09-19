---
title: Teach suss a dependency
description: Write a dependency stub for a package suss cannot read, so extraction sees the queue it publishes to or the framework it re-exports.
---

# Teach suss a dependency

Write a YAML file under `suss/stubs/` saying what the package does, and extraction reads it before the packs run.

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

With that in place, every call to `publishEntry(queue, body)` in the project reads as a send to the queue in its first argument, and `suss ask "what writes aws.sqs:ledger-queue"` lists the callers.

Write a stub for a package extraction cannot see inside. A napi-rs crate compiles to a binary before npm ever sees it, and a private wrapper ships only its build output. Extraction follows a call into their exports and stops there, so the queue the wrapper publishes to never reaches a summary.

## Draft one from the code

```
$ suss infer stub @acme/ledger-native
Drafted suss/stubs/acme-ledger-native.yaml: 2 exports from 3 call sites. Fill the blanks, then re-run extract.
```

suss builds the draft from what your project already shows, and it leaves the semantics blank, because the code cannot tell you those:

```yaml
# Draft stub for @acme/ledger-native, from 3 observed call sites.
# Fill each blank from the package's own source, then delete the
# notes. The statement kinds are in design/proposals/dependency-stubs.md.
package: "@acme/ledger-native"
authored: ""  # who filled the blanks, e.g. agent
from: ""  # what the claims were read from, e.g. crate source at 1.4.2
statements:
  # closeLedger: 1 call
  #   src/ledger.ts:14  ()
  - kind: performs-call
    export: "closeLedger"
    system: ""  # what the call reaches: aws.sqs, aws.events, axios
    spec: {}  # argument meanings, e.g. { subject: { at: 0 }, payload: { at: 1 } }
  # publishEntry: 2 calls
  #   src/ledger.ts:6  (config.queueUrl, entry)
  #   src/ledger.ts:10  ("ledger-refunds", entry)
  - kind: performs-call
    export: "publishEntry"
    system: ""  # what the call reaches: aws.sqs, aws.events, axios
    spec: {}  # argument meanings, e.g. { subject: { at: 0 }, payload: { at: 1 } }
```

What counts as evidence depends on the language. In TypeScript it is every call into the package, grouped by export, with the argument shapes from each site written in as comments. In Python it is every import of the package or of a submodule of it. A `re-exports` match is exact per module, so the draft writes one file per imported module, and you have to leave `-o` off:

```
$ suss infer stub myapp --dir services/shop
Drafted suss/stubs/myapp-behaviors.yaml, suss/stubs/myapp-exports.yaml, suss/stubs/myapp-invoices.yaml, suss/stubs/myapp-reports.yaml, suss/stubs/myapp-wrappers-restx.yaml: 5 imported modules from 7 import sites. Fill the blanks, then re-run extract.
```

In Ruby it is every `require` of the package and every class whose superclass comes from it. You get one `extends-base` statement per superclass, with `class:` filled in and `extends:` left for you. A class extending one of the shipped Ruby packs' own root classes is skipped, because the pack already handles it.

To fill the blanks you need the package's own source, so this is a job for whoever can read it. An agent usually can, a Rust crate included: draft from the evidence, read the dependency, fill in the semantics, record where the claims came from, and commit the file. `-o -` prints the draft instead of writing it, and an MCP host gets the same skeleton from the `suss_stub_draft` tool.

## The file

Stub files live in `suss/stubs/` at the project root, one file per package. `.yaml`, `.yml` and `.json` all parse against one schema, and the extension decides which parser runs. Most people write YAML, because a draft's blanks and its notes about where the claims came from are comments.

Each file has a `package`, at least one statement, and optionally `authored` (who wrote it) and `from` (what they read):

| kind | Fields | States |
|---|---|---|
| `performs-call` | `export`, `system`, `spec` | an export calls into a system |
| `composes-decorator` | `export`, `composes: { module, name }` | an export wraps a known decorator |
| `re-exports` | `of` | the package re-exports a framework |
| `extends-base` | `class`, `extends` | a class in the package a project extends, and the root class it descends from |

`performs-call` routes to a pack by its `system`: `aws.sqs` feeds the aws-sqs pack, `aws.events` feeds aws-eventbridge, and `axios` feeds axios. A `system` outside those three parses and then feeds nothing. The `spec` fields are the same ones the matching pack takes, so a statement can express anything you could configure on the pack.

`composes-decorator` feeds the NestJS packs, for `@nestjs/common`'s `Controller` and `@nestjs/graphql`'s `Resolver`. `re-exports` feeds the fastapi and flask-restx packs, for a Python module of yours in front of either. `extends-base` feeds graphql-ruby, rails, or both: `extends:` decides, and a root class in neither list goes to both.

Your project's own stated options come first, and the statements are appended after. Editing a stub invalidates the extraction cache, the same way editing a pack config does.

When `from:` has a version in it, the loader compares it against the installed package and prints one line on stderr when they differ, so a stub written against 1.2.0 is re-checked when the project moves to 1.4.2.

## What a stub is not

- **Not type information.** `.d.ts` files already state that.
- **Not for your own code.** Extraction reads that directly. For a route helper of yours, or a factory of yours, suss reads the body and fills the parameters in at each call site.
- **Not verified.** A statement is a claim, with a note of where it came from. Checking claims against a readable package source is designed and not built, so fill in `authored` and `from`.

## The options stubs replaced

Before stubs existed, nine pack options stated dependency facts, including `classDecorators` on the NestJS packs and `baseClassNames` on graphql-ruby. A config file that sets one of those now stops the run and tells you which statement kind took it over. An option configures one pack, while suss reads a statement once and feeds it to every pack that consumes it.

Today your project writes the stub. The plan is for a package to ship its own, pointed at from `package.json` the way `types` points at declarations, so a consumer configures nothing. That gives the loader a second place to look, and the format stays the same.
