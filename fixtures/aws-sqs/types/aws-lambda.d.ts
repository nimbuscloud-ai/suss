// Ambient stub of the @types/aws-lambda surface this fixture uses.
// The fixture isn't an installed package — there's no node_modules —
// so we declare the module shape inline. Real consumers would
// `npm install --save-dev @types/aws-lambda`.

declare module "aws-lambda" {
  export interface SQSRecord {
    messageId: string;
    body: string;
  }

  export interface SQSEvent {
    Records: SQSRecord[];
  }
}
