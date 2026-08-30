import express from "express";
const bag = { server: express() };
bag.server.get("/m09", (req, res) => { res.status(200).json({ n: 9 }); });
