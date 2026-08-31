// The pack factory, which is what `-f aws-sqs` loads, and the options
// schema. The CLI checks a `-f aws-sqs=config.json` file against that
// schema minus the keys a dependency stub fills.
export { default, optionsSchema } from "@suss/framework-aws-sqs";
