// What `wrangler types` writes: the store types declared as globals.

declare interface KVNamespace {
  get(key: string): Promise<string | null>;
}

declare interface R2Bucket {
  get(key: string): Promise<unknown>;
}
