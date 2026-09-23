// The CLI checks a `-f rails=config.json` file against
// `optionsSchema` before it calls the factory. `suss infer stub` reads
// the root class list to skip a class that extends the library directly.
export {
  declares,
  default,
  optionsSchema,
  RAILS_ROOT_CLASS_NAMES,
} from "@suss/framework-rails";
