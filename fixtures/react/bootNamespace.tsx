// A boot call read off the default import of react-dom/client.

import ReactDOM from "react-dom/client";

function Popup() {
  return <dialog open>popup</dialog>;
}

ReactDOM.createRoot(document.getElementById("popup")!).render(<Popup />);
