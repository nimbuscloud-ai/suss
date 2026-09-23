# @suss/framework-aws-lambda

Framework pack for AWS Lambda handlers. The SAM or CloudFormation template declares which routes and events reach a handler, so the pack starts discovery from the template, where a web framework pack would start from a registration call in the code.

## What this package is

`@suss/framework-aws-lambda` exports a `PatternPack`. It covers:

- **Discovery** through a `discoverUnits` callback. For each source file, the pack walks up to the nearest SAM template (`template.yaml`, `template.yml` or `template.json`). It resolves every `Serverless::Function`'s `Handler` back to a module path and an export, and records units for what the template routes there. Each template is parsed once and memoized. Nested stacks are followed, so a function declared in a child stack points at the same deployed Lambda the declared side does. The pack declares those templates, children included, as its `discoveryInputs`, so their content goes into the extraction cache key. When you edit a template, the next run reads the project again and does not return the result from before the edit.
- **HTTP route units**, each with a REST binding of `(method, path)` that pairs with the route the same template declares. A route on `ANY` is left to the declared side, since one REST binding cannot represent every verb.
- **AppSync resolver units**, one per `Query`, `Mutation` or `Subscription` field the template routes to the handler. When the field is on any other type, the handler keeps those fields recorded on it without claiming an API surface, because no client can address such a field by itself.
- **Accounting units** for a handler that an SQS, Schedule, SNS or S3 event reaches, marked `recognized-not-http` with the event types that reached it. The unit's binding records which bus the template routes to it. SQS and S3 map to their own wire, and a Schedule or an EventBridge rule maps to eventbridge. A handler the template routes no event to is reached by invoking it by name, so its binding is the deployed function itself, `unit:lambda <logical id>`. A handler that bound to nothing at all gets one of these too, so suss never drops a recognized handler without saying so.
- **Invoke recognizers** for `InvokeCommand` and `InvokeAsyncCommand` from `@aws-sdk/client-lambda`, declared through `@suss/recognize`. Each one records which function the call reaches and what it sends. See [How an invoke pairs with the function it calls](#how-an-invoke-pairs-with-the-function-it-calls).
- **Terminals**: `return { statusCode, body }` (with `JSON.stringify(x)` unwrapped to the shape of `x`), `return { batchItemFailures }`, and `throw`. A unit that is not HTTP also counts any object it returns and a fall off the end of the body. Nothing constrains what such a handler returns, and a queue consumer acknowledges a batch by not throwing.
- **Input mapping**: `(event, context)`, by position.
- **Request spelling**, for a route behind a proxy integration: `event.headers`, `event.queryStringParameters` and `event.pathParameters`, each read by the field it wants, and `event.body`. The body arrives as a string the handler parses, so a read of it records that the body was taken whole. suss compares a boundary intent's `receives` block against those reads.
- **Transparent wrapper**: `Sentry.wrapHandler` from `@sentry/aws-serverless`, whose handler is argument 0. A wrapper written in the project needs no declaration, because the adapter reads the factory's body.
- **Library env vars**: the variables with the `POWERTOOLS_` prefix that `@aws-lambda-powertools/` reads from inside `node_modules`, where no walk over the project would find the code that reads them.

Most handlers build the response object in a helper instead of at the return, and each service writes its own helper, so the pack does not try to list them. The adapter follows a returned call into the project and applies the same declaration to the object it finds there. It reads the helper's parameters to see which argument supplies which field. So a service that writes `json(status, payload)` and one that writes `json(payload, status)` both come out right.

The pack has no import gate, on purpose. A TypeScript handler imports `APIGatewayProxyHandlerV2` from `aws-lambda` to annotate its export. A JavaScript handler has nothing to annotate and does not import it, so gating on that import would extract nothing from a JavaScript service. The template acts as the gate instead, and works better, because it lists the handlers directly.

## How an invoke pairs with the function it calls

Both sides of an invoke are a `unit-invocation` boundary. Its identity is the platform plus the name the platform knows the function by. The invoked function's own summary records its logical id, and a call has to resolve to the same string.

```ts
await lambda.send(
  new InvokeCommand({
    FunctionName: process.env.REPORT_BUILDER_FUNCTION,
    Payload: JSON.stringify({ orderId }),
  }),
);
```

`FunctionName` accepts a bare name, a partial ARN or a full ARN, so the reader cuts each down to the function name inside it. That step matters: an ARN contains an account and a region, so a dev ARN and a prod ARN for the same function differ byte for byte.

A name that only exists once the stack is deployed reaches the code as an env var, and the recognizer keeps the variable's name. The checker then looks up what that variable points at in the invoking function's own `Environment` block:

```yaml
  OrderApi:
    Type: AWS::Serverless::Function
    Properties:
      Environment:
        Variables:
          REPORT_BUILDER_FUNCTION: !Ref ReportBuilder
```

That resolves to `ReportBuilder`, the logical id the invoked function's summary records. A queue URL goes through the same chain, and both use `deployedRefs` in `@suss/behavioral-ir`. A drafted intent document follows it too, so the document gives the function the invoke reaches instead of the variable that points to it.

When this run cannot settle a call's target, the pack records the invoke with no name, so a service that invokes something still shows up as invoking. A call to a function that no deployment in the run declares gets a `unitInvocationTargetUnknown` warning. That is usually a function in another stack.

## Options

None. The pack reads everything from the template or the code, so there is nothing to configure.

There used to be a `subjectFactories` option, for a project whose SQS consumers are built by a handler factory that states a subject:

```ts
export const handler = makeSubjectHandler(
  { name: "paid-worker", subject: "billing.invoicePaid" as const },
  async (message) => { ... },
);
```

The option told suss that the property called `subject` was the channel, and the consumer bound to `bus:aws_sqs billing.invoicePaid`. That was the wrong boundary. A producer sends to a queue and never to a subject, so the two ends never matched on that name. A service that also read its template ended up with two message-bus boundaries for one handler.

The queue is the boundary, and the template is where it is declared. A consumer's binding records the bus and leaves `channel: null`, and the declared consumer for the same deployable unit fills in the channel. That is how the checker finds the code behind a declared consumer. `withDeclaredDelivery` in `@suss/behavioral-ir` makes the same join for anything that reads summaries by boundary key. `suss infer intent` uses it, so a drafted document for one of these handlers lists the queue from the template above the outcomes the handler produces.

The subject itself is a field of the message, and `suss check` compares the fields a consumer reads against the fields the producers on that queue send. A config file that still sets `subjectFactories` gets a warning, and in 0.22.0 it stops the run.

## Where it fits in suss

The pack depends on `@suss/extractor` for the `PatternPack` type, and on `@suss/manifest-aws` to load the template tree and read the function resources and their events. It uses `@suss/recognize` for the declared invoke chains, and `@suss/adapter-typescript` for the discovery context the callback uses to ask about a file's exported functions. `ts-morph` is a peer dependency.

## Coverage

![coverage](../../../.github/badges/coverage-aws-lambda.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
