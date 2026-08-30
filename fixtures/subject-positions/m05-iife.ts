import express from "express";
export const app = (() => {
  const inner = express();
  inner.get("/m05", (req, res) => { res.status(200).json({ n: 5 }); });
  return inner;
})();
