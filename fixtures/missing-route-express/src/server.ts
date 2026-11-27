import express from "express";

import { ordersRouter } from "./orders";

const app = express();
app.use(express.json());
app.use("/api/orders", ordersRouter);
app.use("/assets", express.static("public"));
app.listen(3000);
