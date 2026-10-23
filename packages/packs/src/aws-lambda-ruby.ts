// The CLI checks a `-f aws-lambda-ruby=config.json` file against
// `optionsSchema` before it calls the factory.
export {
  awsLambdaRuby as default,
  declaresRuby as declares,
  optionsSchema,
} from "@suss/framework-aws-lambda";
