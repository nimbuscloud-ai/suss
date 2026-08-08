// The handler behind both SQS wirings in serverless.yml.
export const handler = async (event: {
  Records: Array<{ body: string }>;
}): Promise<void> => {
  for (const record of event.Records) {
    JSON.parse(record.body);
  }
};
