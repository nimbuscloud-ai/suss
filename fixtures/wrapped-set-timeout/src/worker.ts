// Timers whose callback is a method, a bound method, or a local
// function that has the timer's name.

import { setTimeout as nodeSetTimeout } from "node:timers";

export class Batcher {
  private pending: string[] = [];

  add(item: string): void {
    this.pending.push(item);
    setTimeout(() => this.flush(), 20);
    setTimeout(this.flush.bind(this), 40);
  }

  flush(): void {
    console.log(this.pending.splice(0).join(","));
  }
}

export function viaNodeTimers(): void {
  nodeSetTimeout(() => {
    console.log("node timers");
  }, 5);
}

export function shadowed(): void {
  const setTimeout = (fn: () => void) => fn();
  setTimeout(() => {
    console.log("ran now");
  });
}
