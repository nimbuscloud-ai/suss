# @suss/framework-bullmq

Pattern pack for [BullMQ](https://docs.bullmq.io/). It reads both sides of a job queue: the worker that processes jobs, and the code that adds them. The two pair on the queue name, and a reach question from the code that adds a job goes on into the worker that runs it.

```ts
import { Queue, Worker } from "bullmq";

const emails = new Queue("emails");

export async function signUp(userId: string) {
  await emails.add("welcome", { userId });
}

new Worker("emails", async (job) => {
  await sendWelcome(job.data.userId);
});
```

`signUp` records a message send on `bus:bullmq emails`, and the worker's processor becomes a consumer on the same channel.

## What it reads

- **Workers.** In `new Worker(queueName, processor, opts)`, the processor becomes a unit of kind `consumer`, bound to `message-bus { messageBus: "bullmq", channel: queueName }`. The processor can be written inline or passed by name, including a function imported from another module. Its reads, writes and calls belong to that unit. The processor's first parameter has the role `job` and its second the role `token`.
- **Adds to a queue.** `queue.add(name, data, opts)` on a queue built with `new Queue(queueName)` records a `message-send` effect on channel `queueName`, with `data` as the body and `name` as the routing key. `queue.addBulk([...])` records one send per job in the list, and `queue.upsertJobScheduler(id, repeat, template)` records a send of the job its template describes.
- **Flows.** `flowProducer.add({ name, queueName, data })` and `flowProducer.addBulk([...])` record a send on each job's own `queueName`.

The queue name settles through the adapter's value resolution: a string literal, a `const`, or a constant imported from another module. A queue built in another module and imported, kept on a class field, or returned by a project function such as `createJobsQueue()` is followed to the `new Queue(...)` that built it. The job name is recorded only when it is a literal.

## Channel identity

A worker takes every job on its queue, so the channel is the queue name alone. The job name is not part of it. This follows the message-bus channel convention in `@suss/ir-core`.

When a queue name does not settle, the send is still recorded, with `channel: null`, and the summary gets an `unfollowedCall` gap on the call saying the job could not be settled. A worker whose queue name does not settle is a consumer with `channel: null`. Neither is paired with anything, because a guessed channel would pair a producer with the wrong worker.

A BullMQ worker that no code adds jobs to is reported as `messageBusConsumerOrphan`, the same as an SQS consumer. A repeatable job is set up in code with `upsertJobScheduler`, which this pack reads, so a worker fed only by a schedule still has a producer.

## What it does not read

- **A queue handed in as a parameter.** `function send(queue: Queue) { queue.add(...) }` is not recorded, because the origin check reads where a value was built and only a type says this one is a queue.
- **A queue the run cannot follow to one construction.** A queue kept in a global that is also written from outside the code, as with `globalThis` caches, has more than one possible source, and its adds are not recorded.
- **A sandboxed processor.** `new Worker("emails", "./processor.js")` hands BullMQ a file path, and the pack gives it no unit.
- **The job payload on the worker side.** The processor reads the payload off `job.data`, and suss does not yet compare those reads with the body an add sends.
- **A flow's children.** Only the top job of each flow is recorded.
- **`Queue` from another package.** Only `Queue`, `Worker` and `FlowProducer` imported from `bullmq` are read. The older `bull` package is not.

## Where it fits in suss

Workers are found with the `callbackArgument` discovery match and a declared binding whose channel is `callArgument`, both read by the TypeScript adapter. The sends are `messageSends` declarations from `@suss/recognize`. `@suss/checker` pairs each send with the consumer on its channel and records a `sent` call between them, which is how a reach question follows the add into the worker.

## Coverage

![coverage](../../../.github/badges/coverage-bullmq.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
