// Runtime configuration, read once and awaited by whoever builds a
// client out of it.

export interface Config {
  apiKey: string;
  region: string;
}

export async function loadConfig(): Promise<Config> {
  const response = await fetch("/config");
  return (await response.json()) as Config;
}
