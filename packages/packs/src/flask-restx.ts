// The pack factory, which is what `-f flask-restx` loads, and the options
// schema. The CLI checks a `-f flask-restx=config.json` file against that
// schema minus the keys a dependency stub fills.
export { default, optionsSchema } from "@suss/framework-flask-restx";
