// The pack factory, which is what `-f apollo-client` loads, and what a
// `-f apollo-client=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/client-apollo";
