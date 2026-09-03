// The pack factory, which is what `-f rails` loads, the options
// schema, and the root class list `suss infer stub` reads to skip a
// class that extends the library directly.
export {
  default,
  optionsSchema,
  RAILS_ROOT_CLASS_NAMES,
} from "@suss/framework-rails";
