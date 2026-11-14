// React 17's boot with render and hydrate imported by name.

import { hydrate, render } from "react-dom";

function Settings() {
  return <section>settings</section>;
}

function Profile() {
  return <section>profile</section>;
}

render(<Settings />, document.getElementById("settings"));
hydrate(<Profile />, document.getElementById("profile"));
