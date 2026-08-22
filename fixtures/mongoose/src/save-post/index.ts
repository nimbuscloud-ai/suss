// Writes to the explicit "blog_posts" collection through save(),
// which the pack resolves by walking back through the constructor.

import { Post } from "../../models/post.js";

export async function handler(event: {
  title: string;
  body: string;
  authorId: string;
}): Promise<unknown> {
  const post = new Post({
    title: event.title,
    body: event.body,
    authorId: event.authorId,
  });
  await post.save();
  return { id: post._id };
}
