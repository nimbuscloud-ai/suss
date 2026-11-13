// A root kept in a variable and rendered into on the next line.

import { createRoot } from "react-dom/client";

function Sidebar() {
  return <nav>sidebar</nav>;
}

const root = createRoot(document.getElementById("sidebar")!);
root.render(<Sidebar />);
