// A server-rendered page hydrated in place. hydrateRoot takes the
// element second, and nothing calls render.

import { hydrateRoot } from "react-dom/client";

function Storefront() {
  return <section>storefront</section>;
}

hydrateRoot(document.getElementById("store")!, <Storefront />);
