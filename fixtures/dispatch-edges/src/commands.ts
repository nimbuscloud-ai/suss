export async function runInit(args: string[]): Promise<number> {
  return await initInteractive(args);
}

export async function initInteractive(args: string[]): Promise<number> {
  if (args.includes("--plain")) {
    return 0;
  }
  return 2;
}

export async function runCheck(args: string[]): Promise<number> {
  if (args.includes("--fail")) {
    return 1;
  }
  return 0;
}
