# @suss/contract-serverless

Generate suss `BehavioralSummary[]` from a [Serverless Framework](https://www.serverless.com/framework/docs) service file. A `serverless.yml` deploys working Lambdas, and before this reader existed suss saw none of them: no deployable unit, no environment contract, no event wiring.

## What this package is

The framework compiles a service file into one CloudFormation stack. Each function becomes a Lambda, each event becomes the resource that triggers it, and the `resources:` block is copied in as written. So this reader restates the service in SAM's form and hands that to [`@suss/contract-cloudformation`](../cloudformation/), rather than growing a second set of summary builders that would drift from it. A queue wired in a serverless.yml and the same queue wired in a SAM template come out as the same summary.

| Service file | What it becomes |
|---|---|
| `provider.runtime`, `provider.environment` | SAM `Globals.Function`: defaults every function inherits, with `globals` provenance on each inherited variable |
| `functions.<name>` | one Lambda, keyed by the name it is written under, with `handler` pointing at the code that runs it |
| `events[].httpApi` | an API Gateway v2 route |
| `events[].http` | an API Gateway v1 (REST) route |
| `events[].sqs` | a queue consumer, channelled on the queue the ARN points at |
| `events[].sns` | a topic subscription |
| `events[].schedule` | a scheduled invocation, with `enabled: false` for a rule that deploys switched off |
| `events[].eventBridge` | a rule, reduced to the detail-types it routes, or a schedule |
| `resources.Resources` | raw CloudFormation, variables resolved, read as its own document |

## Variables

`${self:...}` points at a path inside the same document, so it resolves here, fallback and all. Every other source (`env:`, `opt:`, `cf:`, `ssm:`, `param:`, `file(...)`, and whatever a plugin registers) refers to a value that a deploy supplies, so the reader keeps the reference as a symbolic token instead of resolving it, guessing at it, or dropping it: an `sqs` event whose ARN is `${env:AUDIT_QUEUE_ARN}` gets the channel `env:AUDIT_QUEUE_ARN`. The token says which binding would ground the boundary, where a null would only say that the wiring is specified somewhere else.

A fallback resolves only for a `self:` reference, where the document states both sides. `${opt:region, 'us-east-1'}` stays symbolic, because the document does not state which way an invocation went.

The framework resolves its variables across the whole document before it compiles anything, so the `resources:` block goes through the same resolver: a table written `TableName: ${self:custom.tableName}` is a name by the time CloudFormation sees it, not the reference text. One reference is left exactly as written there: the one whose source is not the framework's. `Fn::Sub` writes `${AWS::Region}` in the same syntax, and rewriting it would turn an intrinsic that the document meant into a token that nothing resolves.

## Two documents, one service

The functions block and the `resources:` block deploy into a single stack, so a logical id means the same thing in both and a queue declared under `resources:` is the queue an `sqs` event points at. They have different provenance labels, built the way a nested stack's label is: `serverless:services/orders/serverless.yml` and `serverless:services/orders/serverless.yml#resources`. A reader can tell which block declared what, and the flow walk still scopes both to one service, since it scopes on the part before the `#`. The label says where the service file lives in the repository, so a monorepo full of services keeps them apart.

## Minimal usage

```ts
import { serverlessFileToSummaries } from "@suss/contract-serverless";
import fs from "node:fs";

// The path may name the service file or the directory holding it.
const summaries = serverlessFileToSummaries("serverless.yml");
fs.writeFileSync("provider.json", JSON.stringify(summaries, null, 2));
```

From the CLI:

```sh
suss contract --from serverless serverless.yml -o service.json
```

## What it abstains on, and says so

Each of these writes a line to stderr giving the function, the block, and what stopped the read, so wiring that nobody read is never mistaken for wiring that nobody wrote. Pass `onUnread` to collect them instead.

- **Plugins.** A service that loads plugins is reported once. A plugin can add, rename, or rewrite functions and events, and what it declares is not in the document.
- **A service file that is a program.** The reader recognizes a `serverless.ts` or `serverless.js` and reports it: a program declares the service, and a reader does not run one to find out what it says. When a directory has a parseable service file alongside one of these, the reader reads the parseable one, the way the framework prefers it. A path with no service file at all is an error, since the caller pointed at it.
- **Event kinds outside the list above.** `kinesis`, `stream`, `alb`, `websocket`, `cognitoUserPool`, and the rest are reported, not dropped.
- **A route whose method or path a deploy supplies.** A path such as `/${env:PREFIX}/orders` describes no route this document states, and a token substituted into a path would pair with a route nobody wrote. The rest of the function's events still read.
- **A handler the document does not state.** The function is skipped: nothing says which code runs it.

## Limitations (v0)

- **Code scope is the service directory.** The framework packages the whole service into every function's artifact unless `package.individually` narrows it per function, which this reader does not read. A service that sets it gets a scope wider than what deploys.
- **`provider.region` is read and left symbolic.** No boundary keys on a region today.
- **Cross-block routing is not composed.** An EventBridge rule declared under `resources:` that targets a queue an `sqs` event drains does not lend the consumer its subject, the way it would inside one CloudFormation template. Each block is read as its own document.
- **`stage` and multi-stage overrides are not applied.** A value that differs per stage comes out as whatever the document states, with no stage bound.

## Where it fits in suss

Depends on `@suss/contract-cloudformation` (which owns every summary builder this reader reaches), `@suss/manifest-aws` (for the CloudFormation intrinsic tags the `resources:` block uses), `@suss/behavioral-ir`, and `yaml`.

## Coverage

![coverage](../../../.github/badges/coverage-contract-serverless.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
