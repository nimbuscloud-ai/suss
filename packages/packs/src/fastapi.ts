// The pack factory, which is what `-f fastapi` loads, and the options
// schema. The CLI checks a `-f fastapi=config.json` file against that
// schema minus the keys a dependency stub fills.
export { default, optionsSchema } from "@suss/framework-fastapi";
