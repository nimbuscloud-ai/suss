// The project's own record type, in a folder that happens to be called
// aws-lambda.

export interface SQSRecord {
  body: string;
  receivedAt: string;
}
