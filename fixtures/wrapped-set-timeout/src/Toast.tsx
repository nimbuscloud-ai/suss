// A component that hides itself after a delay: the timer is set inside
// an effect and inside an event handler, and through window.

import { useEffect, useState } from "react";

import { later } from "./timers.js";

export function Toast({ message }: { message: string }) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const handle = setTimeout(() => {
      setOpen(false);
    }, 3000);
    return () => clearTimeout(handle);
  }, []);

  useEffect(() => {
    window.setTimeout(() => {
      console.info("toast shown", message);
    }, 0);
  }, [message]);

  const dismiss = () => {
    later(() => setOpen(false), 150);
  };

  return (
    <div role="status" hidden={!open}>
      <button type="button" onClick={dismiss}>
        {message}
      </button>
    </div>
  );
}
