// Kept separate from the process entry point so the app can be
// exercised without binding a port.

import express from "express";

import { dispatchingMiddleware } from "./middleware/dispatch";
import { ordersRouter } from "./routes/ordersRouter";

const app = express();

app.use("/api/orders", ordersRouter);

// Anything the router doesn't claim falls through here, where the
// sub-path picks the concrete handler out of a small map.
app.all("/api/orders/*", dispatchingMiddleware);

export default app;
