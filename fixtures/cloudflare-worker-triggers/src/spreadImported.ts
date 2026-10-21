// The handler comes from another module through a spread.

import { fetch } from "./importedHandler";

const base = { fetch };

export default { ...base };
