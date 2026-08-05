// Ambient stub of the @types/aws-lambda surface this fixture uses.
// The fixture has no node_modules, so the module shape is declared
// inline. A consuming project would install @types/aws-lambda.

declare module "aws-lambda" {
  export interface ALBResult {
    statusCode: number;
    body?: string;
  }

  export type ALBHandler = (event?: unknown) => Promise<ALBResult>;
}
