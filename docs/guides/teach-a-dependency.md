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

With that in place, every call to `publishEntry(queue, body)` in the project reads as a send to the queue its first argument says, and `suss ask "what writes aws.sqs:ledger-queue"` lists the callers.

This is for a package extraction cannot see inside. A napi-rs crate compiles to a binary before npm ever sees it; a private wrapper ships only its build output. Extraction follows a call into their exports and stops, so the queue the wrapper publishes to never reaches a summary.

## Draft one from the code

```
$ suss infer stub @acme/ledger-native
Drafted suss/stubs/acme-ledger-native.yaml: 2 exports from 3 call sites. Fill the blanks, then re-run extract.
```

The draft is built from what the project already shows, and it leaves the semantics blank, because the semantics are what the code cannot say:

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

What counts as evidence depends on the language. For TypeScript it is every call into the package, grouped by export, with the argument shapes seen at each site written in as comments. For Python it is every import of the package or a submodule of it; a `re-exports` match is exact per module, so the draft writes one file per imported module and `-o` has to be left off:

```
$ suss infer stub myapp --dir services/shop
Drafted suss/stubs/myapp-behaviors.yaml, suss/stubs/myapp-exports.yaml, suss/stubs/myapp-invoices.yaml, suss/stubs/myapp-reports.yaml, suss/stubs/myapp-wrappers-restx.yaml: 5 imported modules from 7 import sites. Fill the blanks, then re-run extract.
```

For Ruby it is every `require` of the package and every class whose superclass is spelled from it, one `extends-base` statement per superclass, with `class:` filled in and `extends:` left for you. A class extending one of the shipped Ruby packs' own root classes is skipped, since the pack already stops there.

Filling the blanks takes the package's own source. That is a job for whoever can read it, and an agent usually can, a Rust crate included: draft from the evidence, read the dependency, fill the semantics, record the provenance, commit. `-o -` prints the draft instead of writing it, and an MCP host gets the same skeleton from the `suss_stub_draft` tool.

## The file

Stub files live in `suss/stubs/` at the project root, one file per package. `.yaml`, `.yml` and `.json` all parse, against one schema, chosen by extension. YAML is the authoring default, because a draft's blanks and its provenance notes are comments.

Each file has a `package`, at least one statement, and optionally `authored` (who wrote it) and `from` (what they read):

| kind | Fields | States |
|---|---|---|
| `performs-call` | `export`, `system`, `spec` | an export calls into a system |
| `composes-decorator` | `export`, `composes: { module, name }` | an export wraps a known decorator |
| `re-exports` | `of` | the package re-exports a framework |
| `extends-base` | `class`, `extends` | a class in the package a project extends, and the root class it descends from |

`performs-call` routes to a pack by its `system`: `aws.sqs` feeds the aws-sqs pack, `aws.events` feeds aws-eventbridge, and `axios` feeds axios. A `system` outside those three parses and then feeds nothing. The `spec` fields are the same ones the matching pack takes, so anything the pack could be told, a statement can say.

`composes-decorator` feeds the NestJS packs, for `@nestjs/common`'s `Controller` and `@nestjs/graphql`'s `Resolver`. `re-exports` feeds the fastapi and flask-restx packs, for a Python module of yours in front of either. `extends-base` feeds graphql-ruby, rails, or both: `extends:` decides, and a root class in neither list goes to both.

Your project's own stated options come first, and the statements are appended after. Editing a stub invalidates the extraction cache, the same way editing a pack config does.

When `from:` has a version in it, the loader compares it against the installed package and prints one line on stderr when they differ, so a stub written against 1.2.0 is re-checked when the project moves to 1.4.2.

## What a stub is not

- **Not type information.** `.d.ts` files already state that.
- **Not for your own code.** Extraction reads that directly. A route helper of yours, a factory of yours, a function in front of `os.environ`: suss reads the body and fills the parameters in at each call site.
- **Not verified.** A statement is a claim with its provenance attached. Checking claims against a readable package source is designed and not built, which is why `authored` and `from` are worth filling in.

## The options stubs replaced

Nine pack options stated dependency facts before stubs existed, `classDecorators` on the NestJS packs and `baseClassNames` on graphql-ruby among them. A config file setting one of those now stops the run and says which statement kind took it over. The difference is more than location: an option configures one pack, and a statement is read once and fed to every pack that consumes it.

Today the project writes the stub. The direction is a package shipping its own, pointed at from `package.json` the way `types` points at declarations, so a consumer configures nothing. The loader gains a second place to look and the format does not change.
