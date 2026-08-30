// The pack factory, which is what `-f aws-sqs` loads, and what a
// `-f aws-sqs=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-aws-sqs";
