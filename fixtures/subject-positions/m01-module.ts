import express from "express";
const app = express();
app.get("/m01", (req, res) => { res.status(200).json({ n: 1 }); });
export default app;
