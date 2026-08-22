// Reads from the "blog_posts" collection save-post writes to, so the
// storage pass pairs the two even though the collection name never
// appears in the code, only in the schema's own option.

import { Post } from "../../models/post.js";

export async function handler(event: {
  authorId: string;
}): Promise<unknown> {
  return await Post.find({ authorId: event.authorId }, "title body");
}
