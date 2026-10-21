// The schema is a folder that only the `prisma generate` script in
// package.json points at, and Link is in a file of its own. The route
// selects `titel`, which Link does not declare.

import { PrismaClient } from "@prisma/client";
import express from "express";

const prisma = new PrismaClient();
const app = express();

app.get("/links/:key", async (req, res) => {
  const link = await prisma.link.findFirst({
    where: { key: req.params.key },
    select: { url: true, titel: true },
  });
  if (link === null) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json({ url: link.url });
});

export default app;
