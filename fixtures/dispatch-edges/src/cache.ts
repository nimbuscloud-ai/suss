export async function withCacheDir<T>(
  dir: string,
  run: () => Promise<T>,
): Promise<T> {
  process.env.CACHE_DIR = dir;
  return await run();
}
