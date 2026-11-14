// React 17's boot, read off the default import of react-dom, rendering
// one root and hydrating another.

import ReactDOM from "react-dom";

function Legacy() {
  return <p>legacy</p>;
}

function Checkout() {
  return <form>checkout</form>;
}

ReactDOM.render(<Legacy />, document.getElementById("legacy"));
ReactDOM.hydrate(<Checkout />, document.getElementById("checkout"));
