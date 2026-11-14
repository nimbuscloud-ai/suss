// A root imported under another name.

import { createRoot } from "react-dom/client";

import { Shell as App } from "./shell";

createRoot(document.getElementById("app")!).render(<App />);
