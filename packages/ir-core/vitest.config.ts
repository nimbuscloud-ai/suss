import { packageConfig } from "../../vitest.shared.js";

export default packageConfig({
  thresholds: {
    // The branches in these files are the tool's claims about
    // boundary identity, so each file carries its own floor and
    // cannot hide behind the package aggregate (#124).
    "src/boundaryKey.ts": {
      branches: 90,
      lines: 95,
    },
  },
});
