import express from "express";
const deps = { app: express() };
const { app } = deps;
app.get("/m08", (req, res) => { res.status(200).json({ n: 8 }); });
