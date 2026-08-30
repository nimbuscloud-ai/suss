import express from "express";
export function make() {
  const app = express();
  app.get("/m02", (req, res) => { res.status(200).json({ n: 2 }); });
  return app;
}
