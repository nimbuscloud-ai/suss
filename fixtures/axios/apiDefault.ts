// The same shared-instance layout with the instance as the module's
// default export, which many codebases prefer.

import axios from "axios";

export default axios.create({ baseURL: "/api/v2" });
