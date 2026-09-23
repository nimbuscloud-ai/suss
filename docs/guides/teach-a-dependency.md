---
title: Teach suss a dependency
description: Write a dependency stub for a package suss cannot read, so extraction sees the queue it publishes to or the framework it re-exports.
---

# Teach suss a dependency

Write a YAML file under `suss/stubs/` that describes what the package does. Extraction reads it before the packs run.

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

With that file in place, suss records every call to `publishEntry(queue, body)` in the project as a send to the queue in its first argument, and `suss ask "what writes aws.sqs:ledger-queue"` lists the callers.

You need a stub for a package that extraction cannot see inside. A napi-rs crate compiles to a binary before npm ever sees it, and a private wrapper ships only its build output. Extraction follows a call as far as the package's exports and stops there, so the queue the wrapper publishes to never shows up in a summary.

## Draft one from the code

```
$ suss infer stub @acme/ledger-native
Drafted suss/stubs/acme-ledger-native.yaml: 2 exports from 3 call sites. Fill the blanks, then re-run extract.
```

suss builds the draft from the calls your project already makes. It leaves the semantics blank, because your code does not contain them:

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

The draft is built from different evidence in each language. In TypeScript, suss collects every call into the package, groups the calls by export, and writes the arguments from each call site in as comments. In Python it collects every import of the package or of one of its submodules. A `re-exports` statement matches one module exactly, so the draft writes one file per imported module. Leave `-o` off for this case:

```
$ suss infer stub myapp --dir services/shop
Drafted suss/stubs/myapp-behaviors.yaml, suss/stubs/myapp-exports.yaml, suss/stubs/myapp-invoices.yaml, suss/stubs/myapp-reports.yaml, suss/stubs/myapp-wrappers-restx.yaml: 5 imported modules from 7 import sites. Fill the blanks, then re-run extract.
```

In Ruby it collects every `require` of the package and every class whose superclass comes from it. You get one `extends-base` statement per superclass, with `class:` filled in and `extends:` left for you. suss skips a class that extends the root class of one of the shipped Ruby packs, because that pack already handles it.

Filling the blanks takes the package's own source, so whoever can read that source should do it. An agent usually can, even for a Rust crate. It drafts the stub from the evidence, reads the dependency, fills in the semantics, records where the claims came from, and commits the file. `-o -` prints the draft instead of writing it, and an MCP host gets the same skeleton from the `suss_stub_draft` tool.

## The file

Stub files go in `suss/stubs/` at the project root, one file per package. `.yaml`, `.yml` and `.json` files all parse against one schema, and suss picks the parser by the extension. Most people write YAML, because a draft's blanks and its notes about where each claim came from are comments.

Each file has a `package` and at least one statement. It can also have `authored`, for who wrote it, and `from`, for what they read:

| kind | Fields | States |
|---|---|---|
| `performs-call` | `export`, `system`, `spec` | an export calls into a system |
| `composes-decorator` | `export`, `composes: { module, name }` | an export wraps a known decorator |
| `re-exports` | `of` | the package re-exports a framework |
| `extends-base` | `class`, `extends` | a class in the package a project extends, and the root class it descends from |

suss sends a `performs-call` statement to a pack according to its `system`. `aws.sqs` goes to the aws-sqs pack, `aws.events` goes to aws-eventbridge, and `axios` goes to axios. Any other `system` parses and then goes nowhere. The `spec` fields are the ones the matching pack takes, so a statement can express anything you could configure on the pack.

`composes-decorator` statements go to the NestJS packs, for `@nestjs/common`'s `Controller` and `@nestjs/graphql`'s `Resolver`. `re-exports` statements go to the fastapi and flask-restx packs, for a Python module of yours that wraps either one. `extends-base` statements go to graphql-ruby, rails, or both. The value of `extends:` picks which, and a root class in neither pack's list goes to both.

The options your project sets come first, and suss appends the statements after them. Editing a stub invalidates the extraction cache, the same way editing a pack config does.

When `from:` has a version in it, the loader compares that version against the installed package and prints one line on stderr when they differ. A stub written against 1.2.0 then gets flagged for a second look when the project moves to 1.4.2.

## What a stub is not

- **Not type information.** `.d.ts` files already describe types.
- **Not for your own code.** Extraction reads your code directly. For a route helper or a factory of yours, suss reads the body and fills the parameters in at each call site.
- **Not verified.** A statement is a claim with a note of where it came from. A check of claims against readable package source is designed but not built, so fill in `authored` and `from`.

## The options stubs replaced

Before stubs existed, nine pack options described dependencies, among them `classDecorators` on the NestJS packs and `baseClassNames` on graphql-ruby. When a config file sets one of those now, the run stops and prints which statement kind replaced it. An option configures one pack. A statement is read once and goes to every pack that uses it.

For now your project writes the stub. The plan is for a package to ship its own and point at it from `package.json`, the way `types` points at declarations, so a consumer has nothing to configure. The loader would get a second place to look, and the format would stay the same.
