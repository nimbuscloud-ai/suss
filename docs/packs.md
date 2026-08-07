# Packs

A pack teaches suss how to find and interpret code written for a specific framework, runtime, or library, for example, ts-rest for HTTP handlers, or runtime-node for Node's scheduling primitives. Packs are **declarative data**: a `PatternPack` object describing patterns. The language adapter interprets the patterns against the AST.

For the type-by-type pattern catalogue, see [`reference/pack-patterns.md`](reference/pack-patterns.md). For step-by-step instructions on writing a new pack, see [`guides/writing-a-pack.md`](guides/writing-a-pack.md).

## Pack kinds

Four kinds of pack feed the extractor, all using the `PatternPack` interface:

- **Framework packs** discover handlers, components, resolvers, and consumers, the units a framework defines and the shapes they produce. Fifteen ship: ts-rest, Express, Fastify, Hono, Next.js, NestJS REST and GraphQL, Apollo Server, AWS Lambda, React, React Router, Prisma, Drizzle, SQS, and EventBridge. [`reference/packages.md`](reference/packages.md) has the table.
- **Client packs** discover the consumer side: HTTP clients, GraphQL clients, and RPC clients. Today's three are web (`fetch`), axios, and Apollo client.
- **Runtime packs** recognize behavior the runtime defines (not the language spec, not a framework). For Node, `@suss/runtime-node` covers scheduling primitives like `setTimeout` and the `process.*` surface, including `process.env.X` reads, which emit config-read interactions the runtime-config checker pairs against a deployable unit's declared env-var contract. Recognizer-only, no top-level discovery.
- **Contract packs** translate external specifications into `BehavioralSummary[]` directly: OpenAPI documents, GraphQL SDL, committed `.graphql` operation documents, CloudFormation and SAM templates, AppSync resources, Prisma schemas, Storybook stories. They don't use `PatternPack` and aren't covered here, see [`contract-sources.md`](contract-sources.md).

The first three share one interface and the rest of this document. Their differences are which fields they emphasize.

## What a pack describes

A pack answers up to six questions about a framework or runtime:

1. **Discovery**: How do I find handlers / components / call sites in source files? (Framework + client packs.)
2. **Terminals**: What does an output look like? (Framework + client packs.)
3. **Inputs**: How are inputs delivered to the unit? (Framework + client packs.)
4. **Contracts** *(optional)*: If the framework has declared contracts, how do I read them? (Framework packs only.)
5. **Recognizers**: What library calls or property accesses inside *any* unit produce typed effects? (Any pack, primary mechanism for runtime packs.)
6. **Sub-units** *(optional)*: What inline callbacks inside a unit's body should be synthesized as their own units? (Any pack, used by runtime packs and React's pack.)

The shape of `PatternPack` (simplified, see [`reference/pack-patterns.md`](reference/pack-patterns.md) for the full, annotated interface):

```typescript
interface PatternPack {
  name: string;
  protocol: string;             // wire transport: "http", "in-process", "queue", ...
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  inputMapping: InputMappingPattern;
  contractReading?: ContractPattern;
  invocationRecognizers?: InvocationRecognizer[];
  accessRecognizers?: AccessRecognizer[];
  subUnits?: (parent, ctx) => DiscoveredSubUnit[];
  // ...plus version, responseSemantics, discoverUnits, requiresImport
}
```

## Discovery-driven vs recognizer-only

Packs come in two structural shapes, distinguished by whether they discover units or only fire on calls inside units other packs discovered.

**Discovery-driven packs** populate `discovery`, `terminals`, and `inputMapping`. They tell the adapter "here's how to find handlers, here's how their outputs look, here's how their inputs are shaped." Most framework packs (ts-rest, Express, React) and all client packs (web, axios, apollo) are this shape. They may also declare recognizers and sub-units, but those are secondary.

**Recognizer-only packs** leave `discovery: []` and `terminals: []`. They populate `invocationRecognizers` / `accessRecognizers` / `subUnits` plus `requiresImport` if scoped to a specific library. Their job is to fire on calls and property accesses inside whatever units other packs discovered. Runtime packs (runtime-node) and library-specific framework packs (aws-sqs, prisma, drizzle) are this shape.

The distinction matters because the two shapes serve different needs:

- A discovery-driven pack defines a *new boundary type*, Express endpoints become discoverable and pairable units. Without the pack, suss doesn't know Express handlers exist.
- A recognizer-only pack adds *typed semantics to existing units*, runtime-node attaches "this is a scheduling effect" to a `setTimeout` call inside any unit, without claiming the call site as its own unit.

A single pack can do both, but most don't. That separation is what lets recognizers fire across pack boundaries, runtime-node's `schedulingRecognizer` works inside an Express handler, a React component, a CLI entry point, anywhere.

For the full pattern catalogue and interface contracts, continue to [`reference/pack-patterns.md`](reference/pack-patterns.md). For step-by-step instructions on writing a new pack, see [`guides/writing-a-pack.md`](guides/writing-a-pack.md).
