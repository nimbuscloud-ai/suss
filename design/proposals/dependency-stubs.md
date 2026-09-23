# Dependency stubs

Status: draft, seeking alignment. It follows the plan on issue #673.

A dependency stub is a checked-in declaration of what a package does,
written for a package whose behavior the repo's code cannot state: a
compiled internal library whose decorator composes `@Controller`, a
shared wrapper that registers routes, a publish helper whose call
shape only its own source shows. Fourteen pack options across eleven
packs collect exactly these facts today, each with its own schema,
each configured per pack per project. A stub states the fact once,
about the package it is true of, and every pack and checker reads it.

The word comes from the stub / derived contract / inferred contract
split. A stub is the layer a person can write by hand, and it does for
behavior what DefinitelyTyped does for types.

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
because the fourteen options show what projects need: `composes-decorator`
feeds the three `classDecorators` options and graphql-ruby's base
classes, `registers-routes` embeds `RegistrationHelper`,
`re-exports` replaces the two `wrapperModules` options, and
`performs-call` embeds the `ConfiguredCallSpec` family behind the aws
producers, the dynamo request functions, the lambda subject factories,
and the axios factories. A stub adds no recognition vocabulary. It is a
new place to state the same facts.

## How a stub is read

v1 is a projection, on purpose. The CLI loads the project's stubs,
routes each statement to the packs that consume its kind, and merges
it into the option those packs already take, before the factories run.
Packs and adapters do not change. The pack options become an
implementation detail that stubs fill in. Stub content joins the
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
   nothing. This follows the package-exports direction. Nothing in v1
   changes, and the loader looks in one more place.

   A package author may prefer to write the facts next to the exports
   they describe instead of in a separate file. The place for that is
   whatever the ecosystem already uses for the export's interface: a
   JSDoc tag in the `.d.ts` a napi-rs crate ships, a comment on the
   signature in a `.pyi` stub, a `sig/*.rbs` entry for a native gem,
   or a doc comment in the implementation source itself:

   ```ts
   /** @suss performs-call aws.sqs subject=arg0 payload=arg1 */
   export function publishEntry(queue: string, body: Buffer): Promise<void>;
   ```

   ```rust
   /// @suss performs-call aws.sqs subject=arg0 payload=arg1
   #[napi]
   pub fn publish_entry(queue: String, body: Buffer) -> Result<()> { ... }
   ```

   Tags are only for authoring, and suss does not read them at run
   time. A publish step projects them into the shipped stub file, so
   suss never parses the implementation language. Digesting,
   corroboration and drafting all go through the one schema. The loader
   can also read tags directly from an interface artifact an adapter
   already parses, which is the `.d.ts` today. suss deliberately does
   not support annotations at consumer call sites. A stub states facts
   about a package's exports so that every import site benefits.
   Spelling the same fact again at each site is the divergence this
   design exists to remove.
3. Inference replaces the stub. When a wrapper's source is readable,
   following it is better than declaring it, and once inference covers
   a kind of statement, people stop writing it.

## Corroboration

A stub is a claim, and claims get checked. When the described
package's source is readable after all (shipped sources, a workspace
sibling), suss can verify the statement against it and flag a stub
that says something the code does not do. Config options never had
this, because an option is an instruction and makes no claim about a
package. v1 ships without the checker, and adding it later needs no
change to the format.

## How stubs relate to intent

A stub grounds symbolic references the same way a contract artifact
does: boundary intent about `publishOrder` pairs against the
`performs-call` statement when no extraction saw the wrapper's body.
Stubs are therefore read by the same loader that feeds the intent
checker its artifacts, and their statements use the same boundary
vocabulary.

## Format

Both YAML and JSON parse against one schema, chosen by file extension.
YAML is the authoring default and what drafting emits. A draft's marked
blanks and a stub's provenance notes are comments, and JSON has no
comments. The intent artifacts already use YAML, so the parser and the
precedent exist. A tool that emits stubs
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

An agent can finish what suss cannot. The adapters will never read a
crate written in Rust, but an agent can read one in a single sitting.
The intended flow is to draft from evidence, read the dependency's own
source, fill in the semantics and commit the stub. A
stub records its provenance (`authored: agent, from: crate source at
1.4.2`), its claims stay declared confidence, and corroboration marks
the ones it could verify, so a reader can tell a checked statement
from a trusted one, and why the unchecked ones are unchecked.

## Out of scope

- Statements about types (that is what `.d.ts` files are).
- Stubs for first-party code in the same repo (extract reads it).
- A registry of community stubs. The file format has to prove itself
  first.
