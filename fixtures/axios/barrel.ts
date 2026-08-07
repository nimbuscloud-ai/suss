// A barrel re-exporting the shared instance. Resolution follows the
// re-export chain to the construction, so a consumer importing from
// here reads the same client as one importing the building file.

export { client } from "./api";
