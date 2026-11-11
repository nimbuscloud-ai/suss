// Helpers the server actions share. This file does not open with the
// directive, so nothing in it is an action unless a marked module
// exports it.

import { unstable_cache } from "next/cache";

declare const db: {
  archiveOrder(id: string): Promise<void>;
};

export type ActionState = { error?: string; ok?: boolean };

type Schema<T> = {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: string };
};

// Checks the form before the action runs, the way most apps wrap their
// actions. The closure it returns calls the action it was handed.
export function validatedAction<T>(
  schema: Schema<T>,
  action: (data: T, formData: FormData) => Promise<ActionState>,
) {
  return async (_previous: ActionState, formData: FormData) => {
    const result = schema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
      return { error: result.error };
    }
    return action(result.data, formData);
  };
}

// Keeps what the function returns in Next.js's cache. The closure it
// returns calls the cached copy, never the function it was handed.
export function cached<T, P extends unknown[]>(
  fn: (...params: P) => Promise<T>,
  key: string,
) {
  const cachedFn = unstable_cache(async (params: P) => fn(...params), [key]);
  return async (...params: P): Promise<T> => {
    return cachedFn(params);
  };
}

// A marked module re-exports this one, which makes it an action there.
export async function archiveOrder(id: string) {
  await db.archiveOrder(id);
  return { archived: id };
}

// The directive counts only before any other statement, so this
// function is not an action.
export async function logOrder(id: string) {
  console.info(id);
  "use server";
  return id;
}
