// Collection name is explicit here ("blog_posts"), so it does not
// depend on this pack's pluralization guess at all.

import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    title: String,
    body: String,
    authorId: String,
  },
  { collection: "blog_posts" },
);

export const Post = mongoose.model("Post", postSchema);
