// Collection name comes from Mongoose's own default: lowercased and
// pluralized to "users". Read and written from separate handler
// files below, so the storage pass pairs them on that collection.

import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  active: Boolean,
});

export const User = mongoose.model("User", userSchema);
