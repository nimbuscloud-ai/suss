import express from "express";
try {
  const app = express();
  app.get("/m10", (req, res) => { res.status(200).json({ n: 10 }); });
} catch { /* ignore */ }
