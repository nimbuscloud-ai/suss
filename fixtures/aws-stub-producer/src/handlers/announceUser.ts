// Publishes through the project's EventBridge publisher.

import { EventPublisher } from "@acme/async";

const publisher = new EventPublisher({ busName: "users" });

export async function announce(to: EventPublisher, userId: string) {
  await to.emit("user.deleted", { userId }, { partitionKey: userId });
}

export async function announceKind(to: EventPublisher, kind: string) {
  await to.emit(kind, { userId: "u-1" }, { partitionKey: "u-1" });
}

export const handler = async (event: { pathParameters: { id: string } }) => {
  const userId = event.pathParameters.id;
  await announce(publisher, userId);
  await announceKind(publisher, "user.archived");
  return { statusCode: 204, body: "" };
};
