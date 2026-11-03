import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  thresholds: {
    // Filesystem-walk and malformed-template branches are defensive
    // paths that the fixture doesn't exercise; 70% covers the
    // meaningful discovery + extraction logic.
    branches: 70,
  },
});
