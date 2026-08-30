import express from "express";
export class Api2 {
  private app = express();
  wire() { this.app.get("/m07", (req, res) => { res.status(200).json({ n: 7 }); }); }
}
