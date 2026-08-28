# Dependency stubs

Status: draft, seeking alignment. Executes the plan on issue #673.

A dependency stub is a checked-in declaration of what a package does,
written for a package whose behavior the repo's code cannot state: a
compiled internal library whose decorator composes `@Controller`, a
shared wrapper that registers routes, a publish helper whose call
shape only its own source shows. Fourteen pack options across eleven
packs collect exactly these facts today, each with its own schema,
each configured per pack per project. A stub states the fact once,
about the package it is true of, and every pack and checker reads it.

The word comes from the stub / derived contract / inferred contract
split: a stub is the hand-authorable layer, the DefinitelyTyped move
applied to behavior.

## The file

One YAML file per described package, in `suss/stubs/` at the project
root, named by the package:

```yaml
# suss/stubs/@acme/http-kit.yaml
package: "@acme/http-kit"
statements:
  - kind: composes-decorator
    export: ApiController
    composes: { module: "@nestjs/common", name: Controller }
  - kind: registers-routes
    export: mountHealth
    registrations:
      - { method: GET, pathTemplate: /health, handlerArg: handler }
  - kind: re-exports
    of: fastapi
  - kind: performs-call
    export: publishOrder
    call:
      system: aws.sqs
      subject: { at: 0 }
      payload: { at: 1 }
```

Each statement kind reuses a type the extractor already defines,
because the fourteen options are the demand curve: `composes-decorator`
feeds the three `classDecorators` options and graphql-ruby's base
classes, `registers-routes` embeds `RegistrationHelper`,
`re-exports` replaces the two `wrapperModules` options, and
`performs-call` embeds the `ConfiguredCallSpec` family behind the aws
producers, the dynamo request functions, the lambda subject factories,
and the axios factories. No new recognition vocabulary: a stub is a
new place to state the same facts.

## How a stub is read

v1 is a projection, deliberately. The CLI loads the project's stubs,
routes each statement to the packs that consume its kind, and merges
it into the option those packs already take, before the factories run.
No pack changes, no adapter changes; the pack options become an
implementation detail the stub feeds. Stub content joins the
extraction cache digest exactly as pack config does today, so an
edited stub invalidates the same way.

Each pack's option then deprecates over one release: it keeps working,
the CLI notes that the same fact belongs in a stub, and the option
goes when nothing ships it.

## Where stubs come from, in order

1. The project writes one, next to its code, for a dependency suss
   cannot read. This is v1, and the fourteen migrated options are its
   first content.
2. The package ships its own, referenced from its `package.json` the
   way `types` points at declarations. A consumer repo then configures
   nothing. This is the package-exports direction and needs nothing
   from v1 changed, only a second place the loader looks.
3. Inference replaces the stub: when a wrapper's source is readable,
   following it beats declaring it, and a category of statement that
   inference learns to cover stops being written.

## Corroboration

A stub is a claim, and claims get checked. When the described
package's source is readable after all (shipped sources, a workspace
sibling), suss can verify the statement against it and flag a stub
that says something the code does not do. Config options never had
this, because an option is an instruction rather than a claim about a
package. v1 ships without the checker and the format loses nothing by
gaining it later.

## What this is to the intent layer

A stub grounds symbolic references the same way a contract artifact
does: boundary intent about `publishOrder` pairs against the
`performs-call` statement when no extraction saw the wrapper's body.
Stubs are therefore read by the same loader that feeds the intent
checker its artifacts, and their statements use the same boundary
vocabulary.

## Format

YAML and JSON both parse, one schema, chosen by extension. YAML is
the authoring default and what drafting emits, because a draft's
marked blanks and a stub's provenance notes are comments, which JSON
cannot carry; the intent artifacts already committed to YAML, so the
parser and the precedent exist. A tool that emits stubs
programmatically writes JSON if it prefers.

## Drafting, and agents as authors

The package suss cannot see inside is still a package suss observes
from the outside: every import site, every call into it, and the
argument shapes at each call site are in the unfollowed-call evidence
and the caller walk. `suss stub draft <package>` (and `suss_stub_draft`
through the MCP server) turns that into a skeleton: one `performs-call`
candidate per observed callee with the observed argument shapes filled
in, and the semantic fields (which system the call reaches, which
argument is the subject) left as marked blanks.

Agents close the loop suss cannot: a crate written in Rust is
unreadable to the adapters forever, and readable to an agent in one
sitting. The intended flow is draft from evidence, read the
dependency's own source, fill in the semantics, commit the stub. A
stub records its provenance (`authored: agent, from: crate source at
1.4.2`), its claims stay declared confidence, and corroboration marks
the ones it could verify, so a reader can tell a checked statement
from a trusted one, and why the unchecked ones are unchecked.

## Out of scope

- Statements about types (that is what `.d.ts` files are).
- Stubs for first-party code in the same repo (extract reads it).
- A registry of community stubs; the file format has to earn that
  first.
