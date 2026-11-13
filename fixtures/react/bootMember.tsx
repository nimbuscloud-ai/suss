// A root written as a member of an object of parts, the way compound
// components are grouped.

import { createRoot } from "react-dom/client";

function Root() {
  return <section>inbox</section>;
}

function Empty() {
  return <p>nothing here</p>;
}

const Inbox = { Root, Empty };

createRoot(document.getElementById("inbox")!).render(<Inbox.Root />);
