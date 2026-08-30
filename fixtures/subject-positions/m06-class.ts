import express from "express";
export class Api {
  build() {
    const app = express();
    app.get("/m06", (req, res) => { res.status(200).json({ n: 6 }); });
    return app;
  }
}
