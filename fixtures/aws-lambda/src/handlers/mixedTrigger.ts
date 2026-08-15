// Fed by a queue and a timer at once. Two wires means no single
// message-bus binding says which one, so the unit keeps the
// function-call fallback.
export const handler = async (): Promise<void> => {
  return;
};
