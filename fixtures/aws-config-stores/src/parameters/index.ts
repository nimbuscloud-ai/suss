// Lambda that reads two parameters in one call and writes a third.
// The multi-read yields one access per parameter it lists.

import {
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

export async function handler(event: { region: string }): Promise<{
  ok: boolean;
}> {
  await ssm.send(
    new GetParametersCommand({
      Names: ["/prod/db/host", "/prod/db/port"],
      WithDecryption: true,
    }),
  );
  await ssm.send(
    new PutParameterCommand({
      Name: "/prod/app/region",
      Value: event.region,
      Type: "String",
    }),
  );
  return { ok: true };
}
