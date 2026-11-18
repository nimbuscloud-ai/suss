import express from "express";

const app = express();

app.get("/api/v1/widgets", (_req, res) => {
  res.status(200).json([{ id: "w1", name: "Spanner" }]);
});

app.get("/api/v1/widgets/:id", (req, res) => {
  if (req.params.id === "") {
    res.status(404).json({ error: "id is required" });
    return;
  }
  res.status(200).json({ id: req.params.id, name: "Spanner" });
});

export default app;
