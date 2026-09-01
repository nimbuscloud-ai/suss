// Ambient stub of the @types/aws-lambda surface this fixture uses. The
// fixture has no node_modules of its own, so the module shape is
// declared inline. A deployed project installs @types/aws-lambda.

declare module "aws-lambda" {
  export interface SNSMessage {
    MessageId: string;
    Subject?: string;
    Message: string;
    TopicArn: string;
  }

  export interface SNSEventRecord {
    EventSource: string;
    Sns: SNSMessage;
  }

  export interface SNSEvent {
    Records: SNSEventRecord[];
  }
}
