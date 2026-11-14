// An entry point that boots its root component at module scope. The
// component is exported by nothing, so only the boot call finds it.

import { createRoot } from "react-dom/client";

function Widget() {
  return <aside>widget</aside>;
}

createRoot(document.getElementById("widget")!).render(<Widget />);
