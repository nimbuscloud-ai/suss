// Reads and writes one report object in the uploads bucket. The bucket
// name here is the one main.tf declares, so the two sides pair.

import { Storage } from "@google-cloud/storage";

const storage = new Storage();

export async function publishReport(body: string) {
  await storage.bucket("acme-uploads").file("reports/latest.csv").save(body);
}

export async function readReport() {
  const [data] = await storage
    .bucket("acme-uploads")
    .file("reports/latest.csv")
    .download();
  return data;
}
