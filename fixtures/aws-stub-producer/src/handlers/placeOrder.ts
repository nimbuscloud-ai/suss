// Sends through the project's dispatcher. Some subjects are a parameter,
// a constant or a union-typed parameter, which a reader that settles
// values could read differently.

import { CommandDispatcher } from "@acme/async";

type Dispatcher = CommandDispatcher & { region: string };
type MaybeDispatcher = Dispatcher | undefined;
type Topic = "order.shipped" | "order.cancelled";

const dispatcher = new CommandDispatcher({ region: "eu-west-1" });
const AUDIT_SUBJECT = "order.audited";

export async function place(to: CommandDispatcher, orderId: string) {
  await to.dispatch(
    "order.placed",
    { orderId, total: "9" },
    { queueUrl: process.env.ORDERS_QUEUE_URL },
  );
}

export async function placeKind(to: CommandDispatcher, kind: string) {
  await to.dispatch(kind, { orderId: "o-1" }, { queueUrl: "u" });
}

export async function audit(to: CommandDispatcher, orderId: string) {
  await to.dispatch(AUDIT_SUBJECT, { orderId });
}

export async function copy(to: CommandDispatcher, orderId: string) {
  const body = { orderId, copy: true };
  await to.dispatch("order.copied", body);
}

export async function move(to: CommandDispatcher, topic: Topic) {
  await to.dispatch(topic, { at: Date.now() });
}

export async function serialized(to: CommandDispatcher, orderId: string) {
  await to.dispatch("order.serialized", JSON.stringify({ orderId }));
}

export async function placeMany(to: CommandDispatcher) {
  await to.dispatchBatch("order.placed", []);
}

export async function viaIntersection(to: CommandDispatcher & { region: string }) {
  await to.dispatchBatch("order.joined", []);
}

export async function viaOptional(to: CommandDispatcher | undefined) {
  await to?.dispatchBatch("order.optional", []);
}

export async function viaAlias(to: Dispatcher) {
  await to.dispatchBatch("order.aliased", []);
}

export async function viaMaybe(to: MaybeDispatcher) {
  await to?.dispatchBatch("order.maybe", []);
}

export const handler = async (event: { body: string; topic: Topic }) => {
  const { orderId } = JSON.parse(event.body) as { orderId: string };
  await place(dispatcher, orderId);
  await placeKind(dispatcher, "order.kind");
  await audit(dispatcher, orderId);
  await copy(dispatcher, orderId);
  await move(dispatcher, event.topic);
  await serialized(dispatcher, orderId);
  await placeMany(dispatcher);
  await viaIntersection(Object.assign(dispatcher, { region: "eu-west-1" }));
  await viaOptional(dispatcher);
  await viaAlias(Object.assign(dispatcher, { region: "eu-west-1" }));
  await viaMaybe(undefined);
  await dispatcher.dispatch("order.direct", { orderId });
  return { statusCode: 202, body: JSON.stringify({ orderId }) };
};
