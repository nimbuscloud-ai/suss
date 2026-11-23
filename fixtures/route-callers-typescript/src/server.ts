// Routes that share words with each other, so a question about one of
// them has to leave the others out.

import express from "express";

const app = express();

app.post("/notes", (req, res) => {
  if (!req.body.title) {
    res.status(422).json({ error: "title is required" });
    return;
  }
  res.status(201).json({ id: 1 });
});

app.post("/notes/:id/archive", (req, res) => {
  res.status(204).send();
});

app.post("/shared/notes", (req, res) => {
  res.status(201).json({ id: 2 });
});

app.get("/notes/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.get("/notes/:id/edit", (req, res) => {
  res.status(302).redirect("/login");
});

export default app;
