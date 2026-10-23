// The CLI checks a `-f aws-lambda-python=config.json` file against
// `optionsSchema` before it calls the factory.
export {
  awsLambdaPython as default,
  declaresPython as declares,
  optionsSchema,
} from "@suss/framework-aws-lambda";
