// Lambda that reads a database password out of Secrets Manager and
// rotates an API key. One read and one write against two secrets.

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

export async function handler(event: { key: string }): Promise<{
  ok: boolean;
}> {
  await secrets.send(
    new GetSecretValueCommand({ SecretId: "prod/db/password" }),
  );
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: process.env.API_KEY_SECRET_ID,
      SecretString: event.key,
    }),
  );
  return { ok: true };
}
