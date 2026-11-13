// A component that calls the project's own useEffect, not React's.

import { useEffect } from "./lifecycle";

export function Banner({ message }: { message: string }) {
  useEffect(() => {
    console.info(message);
  }, [message]);

  return <p role="status">{message}</p>;
}
