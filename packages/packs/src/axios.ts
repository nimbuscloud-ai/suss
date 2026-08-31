// The pack factory, which is what `-f axios` loads, and the options
// schema. The CLI checks a `-f axios=config.json` file against that
// schema minus the keys a dependency stub fills.
export { default, optionsSchema } from "@suss/client-axios";
