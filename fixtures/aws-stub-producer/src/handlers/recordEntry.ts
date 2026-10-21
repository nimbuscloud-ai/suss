// Calls the native ledger package the documented stub describes.

import { closeLedger, publishEntry } from "@acme/ledger-native";

const config = { queueUrl: process.env.LEDGER_QUEUE_URL ?? "ledger-queue" };

export const handler = async (event: { body: string }) => {
  const entry = JSON.parse(event.body) as { amount: number };
  await publishEntry("ledger-queue", entry);
  await publishEntry(config.queueUrl, { ...entry, mirrored: true });
  await closeLedger();
  return { statusCode: 201, body: JSON.stringify(entry) };
};
