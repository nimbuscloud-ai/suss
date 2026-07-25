export declare function json(
  statusCode: number,
  payload: unknown,
): { statusCode: number; headers: Record<string, string>; body: string };
