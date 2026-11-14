// A root component wrapped in memo before it is booted.

import { memo } from "react";
import { createRoot } from "react-dom/client";

const Toolbar = memo(() => <menu>toolbar</menu>);

createRoot(document.getElementById("toolbar")!).render(<Toolbar />);
