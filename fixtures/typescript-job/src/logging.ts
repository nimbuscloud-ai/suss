// A logger a job builds while it loads, so module scope has a call
// written as a variable initializer.

export interface JobLogger {
  info(value: unknown): void;
}

export function startLogger(): JobLogger {
  return {
    info: (value) => {
      console.log(value);
    },
  };
}
