import express from "express";
export const make = () => {
  const app = express();
  app.get("/m03", (req, res) => { res.status(200).json({ n: 3 }); });
  return app;
};
