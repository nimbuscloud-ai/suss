# @suss/framework-aws-lambda

Framework pack for AWS Lambda handlers. The SAM or CloudFormation template says which routes and events reach a handler, so discovery starts from the template instead of from a registration call in the code.

## What this package is

`@suss/framework-aws-lambda` returns a `PatternPack` object describing:

- **Discovery** through a `discoverUnits` callback. For each source file the pack walks up to the nearest SAM template (`template.yaml`, `template.yml`, or `template.json`), resolves every `Serverless::Function`'s `Handler` back to a module path and an export, and emits units for what the template routes there. A template is parsed once and memoized, and nested stacks are followed, so a function declared in a child stack points at the same deployed Lambda the declared side does. Those templates, children included, are what the pack declares as its `discoveryInputs`, so their content goes into the extraction cache key: edit a template and the next run reads the project again instead of handing back the answer from before the edit.
- **HTTP route units**, carrying a REST binding of `(method, path)` that pairs with the route the same template declares. A route on `ANY` is left to the declared side, since one REST binding cannot represent every verb.
- **AppSync resolver units**, one per `Query`, `Mutation`, or `Subscription` field the template routes to the handler. A handler behind a field on any other type keeps those fields recorded on it without claiming an API surface, because no client can address such a field on its own.
- **Accounting units** for a handler that an SQS, Schedule, SNS, or S3 event reaches, marked `recognized-not-http` with the event types that got there. The unit's binding says which bus the template routes to it: SQS and S3 map to their own wire, and a Schedule or an EventBridge rule maps to eventbridge. A handler the template routes no event to is reached by being invoked by name, so its binding is the deployed function itself, `unit:lambda <logical id>`. A handler that bound to nothing at all gets one of these too, so a recognized handler is never dropped without a word.
- **Invoke recognizers** for `InvokeCommand` and `InvokeAsyncCommand` from `@aws-sdk/client-lambda`, declared through `@suss/recognize`. Each one records which function the call reaches and what it hands over. See [How an invoke meets the function it reaches](#how-an-invoke-meets-the-function-it-reaches).
- **Terminals**: `return { statusCode, body }` (with `JSON.stringify(x)` unwrapped to the shape of `x`), `return { batchItemFailures }`, and `throw`. A non-HTTP unit reads those plus any object it returns and a fall off the end of the body, since no envelope constrains what it hands back and a queue consumer acknowledges a batch by not throwing.
- **Input mapping**: `(event, context)` positionally.
- **Transparent wrapper**: `Sentry.wrapHandler` from `@sentry/aws-serverless`, whose handler is argument 0. A project-local wrapper needs no declaration, because the adapter reads the factory body.
- **Library env vars**: the `POWERTOOLS_` prefixed variables that `@aws-lambda-powertools/` reads from inside `node_modules`, where no walk over the project would find the reader.

Most handlers build the response object in a helper rather than at the return site, and the helper belongs to the service, so the pack does not try to say which one it is. The adapter follows a returned call into the project and applies the same declaration to the object it finds there, reading the helper's parameters to see which argument supplies which field. A service writing `json(status, payload)` and one writing `json(payload, status)` both come out right.

There is no import gate, on purpose. A TypeScript handler imports `APIGatewayProxyHandlerV2` from `aws-lambda` to annotate its export, and a JavaScript handler has nothing to annotate and writes no such import, so gating on it would extract nothing from a JavaScript service. The template is the gate instead, and a better one, because it says which handlers outright.

## How an invoke meets the function it reaches

Both sides of an invoke are a `unit-invocation` boundary, whose identity is the platform plus the name the platform knows the function by. The invoked function's own summary states its logical id, and a call has to arrive at the same string.

```ts
await lambda.send(
  new InvokeCommand({
    FunctionName: process.env.REPORT_BUILDER_FUNCTION,
    Payload: JSON.stringify({ orderId }),
  }),
);
```

`FunctionName` takes a bare name, a partial ARN or a full one, so the reader reduces each to the name inside it. That reduction matters more than it looks: an ARN has an account and a region in it, so a dev ARN and a prod ARN differ byte for byte while naming one function.

A name that only exists once the stack is deployed reaches the code as an env var, and the recognizer keeps the variable's name. The checker then asks the invoking function's own `Environment` block what that variable points at:

```yaml
  OrderApi:
    Type: AWS::Serverless::Function
    Properties:
      Environment:
        Variables:
          REPORT_BUILDER_FUNCTION: !Ref ReportBuilder
```

which resolves to `ReportBuilder`, the logical id the invoked function's summary states. That is the same chain a queue URL goes through, and both go through `deployedRefs` in `@suss/checker`.

A call whose target this run cannot settle records the invoke with no name, so a service that invokes does not read as one that invokes nothing. A call that names a function no deployment in the run declares gets a `unitInvocationTargetUnknown` warning, which is usually a function in another stack.

## Options

None. Everything this pack reads comes off the template or the code, so there is nothing to point it at.

There used to be a `subjectFactories` option, for a project whose SQS consumers are built by a handler factory that states a subject:

```ts
export const handler = makeSubjectHandler(
  { name: "paid-worker", subject: "billing.invoicePaid" as const },
  async (message) => { ... },
);
```

The option said the property named `subject` was the channel, and the consumer bound to `bus:aws_sqs billing.invoicePaid`. That was the wrong boundary. A producer sends to a queue, not to a subject, so the two ends never met on that name, and a service that also read its template ended up with two message-bus boundaries for one handler.

The queue is the boundary and the template is where it is declared. A consumer's binding says the bus and leaves `channel: null`, and the declared consumer for the same deployable unit fills the channel in. That is how the checker finds the code behind a declared consumer, and `withDeclaredDelivery` in `@suss/behavioral-ir` is the same join for anything reading summaries by boundary key. `suss infer intent` uses it, so drafting a document for one of these handlers writes the queue from the template above the outcomes the handler produces.

The subject itself is a field of the message, and `suss check` compares the fields a consumer reads against the fields the producers on that queue send. A config file that still sets `subjectFactories` is read past with a warning, and stops the run in 0.22.0.

## Where it fits in suss

Depends on `@suss/extractor` for the `PatternPack` type, `@suss/manifest-aws` to load the template tree and read the function resources and their events, `@suss/recognize` for the declared invoke chains, and `@suss/adapter-typescript` for the discovery context the callback asks about a file's exported functions. `ts-morph` is a peer dependency.

## Coverage

![coverage](../../../.github/badges/coverage-aws-lambda.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
