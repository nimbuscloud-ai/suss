// Keeps sessions under the `session` key namespace. The cluster in
// main.tf declares the store; the namespace exists only in this file
// and in whoever else spells the same key shape.

import Redis from "ioredis";

const redis = new Redis();

export async function touchSession(id: string) {
  await redis.setex(`session:${id}`, 3600, "1");
}

export async function readSession(id: string) {
  return redis.get(`session:${id}`);
}
