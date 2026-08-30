import express from "express";
{
  const app = express();
  app.get("/m04", (req, res) => { res.status(200).json({ n: 4 }); });
}
