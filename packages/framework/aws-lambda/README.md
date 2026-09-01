# @suss/framework-aws-lambda

Framework pack for AWS Lambda handlers. The SAM or CloudFormation template says which routes and events reach a handler, so discovery starts from the template instead of from a registration call in the code.

## What this package is

`@suss/framework-aws-lambda` returns a `PatternPack` object describing:

- **Discovery** through a `discoverUnits` callback. For each source file the pack walks up to the nearest SAM template (`template.yaml`, `template.yml`, or `template.json`), resolves every `Serverless::Function`'s `Handler` back to a module path and an export, and emits units for what the template routes there. A template is parsed once and memoized, and nested stacks are followed, so a function declared in a child stack points at the same deployed Lambda the declared side does. Those templates, children included, are what the pack declares as its `discoveryInputs`, so their content goes into the extraction cache key: edit a template and the next run reads the project again instead of handing back the answer from before the edit.
- **HTTP route units**, carrying a REST binding of `(method, path)` that pairs with the route the same template declares. A route on `ANY` is left to the declared side, since one REST binding cannot represent every verb.
- **AppSync resolver units**, one per `Query`, `Mutation`, or `Subscription` field the template routes to the handler. A handler behind a field on any other type keeps those fields recorded on it without claiming an API surface, because no client can address such a field on its own.
- **Accounting units** for a handler that an SQS, Schedule, SNS, or S3 event reaches, marked `recognized-not-http` with the event types that got there. The unit's binding says which bus the template routes to it: SQS and S3 map to their own wire, and a Schedule or an EventBridge rule maps to eventbridge. An event type the pack has no wire for keeps the function-call fallback. A handler that bound to nothing at all gets one of these too, so a recognized handler is never dropped without a word.
- **Terminals**: `return { statusCode, body }` (with `JSON.stringify(x)` unwrapped to the shape of `x`), `return { batchItemFailures }`, and `throw`. A non-HTTP unit reads those plus any object it returns and a fall off the end of the body, since no envelope constrains what it hands back and a queue consumer acknowledges a batch by not throwing.
- **Input mapping**: `(event, context)` positionally.
- **Transparent wrapper**: `Sentry.wrapHandler` from `@sentry/aws-serverless`, whose handler is argument 0. A project-local wrapper needs no declaration, because the adapter reads the factory body.
- **Library env vars**: the `POWERTOOLS_` prefixed variables that `@aws-lambda-powertools/` reads from inside `node_modules`, where no walk over the project would find the reader.

Most handlers build the response object in a helper rather than at the return site, and the helper belongs to the service, so the pack does not try to say which one it is. The adapter follows a returned call into the project and applies the same declaration to the object it finds there, reading the helper's parameters to see which argument supplies which field. A service writing `json(status, payload)` and one writing `json(payload, status)` both come out right.

There is no import gate, on purpose. A TypeScript handler imports `APIGatewayProxyHandlerV2` from `aws-lambda` to annotate its export, and a JavaScript handler has nothing to annotate and writes no such import, so gating on it would extract nothing from a JavaScript service. The template is the gate instead, and a better one, because it says which handlers outright.

## Options

A project whose SQS consumers are built by a handler factory can say where that factory states the subject, so the consumer pairs with its producers.

```json
{
  "subjectFactories": [
    { "property": "subject", "callees": ["sqsConsumer"], "argIndex": 0 }
  ]
}
```

Pass it with `suss extract -f aws-lambda=config.json`.

- `subjectFactories`: where a project's own handler factory states the subject its SQS consumer expects. A handler built by such a factory gets a message-bus binding on that subject instead of the fallback. AWS declares no such factory and nothing here assumes one, so a service that does not write its consumers this way is unaffected.
  - `property`: the property on the factory's config object that contains the subject.
  - `callees`: the factory functions the project builds its consumers with. Optional, since the adapter reads whatever call built the export. Fill it in when two factories in the same service put different things under the same property.
  - `argIndex`: which argument position the config object is in. Left out, every object argument is read.

The queue itself stays on the declared side, since the message-bus pass in `@suss/contract-cloudformation` reads the template's SQS wiring. What the code adds is which subject this consumer listens for.

## Where it fits in suss

Depends on `@suss/extractor` for the `PatternPack` type, `@suss/manifest-aws` to load the template tree and read the function resources and their events, and `@suss/adapter-typescript` for the discovery context the callback asks about a file's exported functions. `ts-morph` is a peer dependency.

## Coverage

![coverage](../../../.github/badges/coverage-aws-lambda.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
