// An entry point that boots inside a function it calls once the page
// is ready.

import { createRoot } from "react-dom/client";

function Dashboard() {
  return <main>dashboard</main>;
}

function mount() {
  createRoot(document.getElementById("dashboard")!).render(<Dashboard />);
}

document.addEventListener("DOMContentLoaded", mount);
