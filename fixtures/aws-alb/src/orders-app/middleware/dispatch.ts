import type { NextFunction, Request, Response } from "express";

import { getOrder } from "../handlers/getOrder";
import { listOrders } from "../handlers/listOrders";

type Handler = (req: Request, res: Response) => void;

// The wildcard route hands every /api/orders/* request here as one
// req.params[0] capture. An empty remainder means the collection;
// anything else is read as an item id, multi-segment remainders
// included, so /api/orders/123/extra looks up the id "123/extra".
const handlersBySubPath: Record<"collection" | "item", Handler> = {
  collection: listOrders,
  item: getOrder,
};

export function dispatchingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const subPath = req.params[0] ?? "";

  if (subPath === "") {
    handlersBySubPath.collection(req, res);
    return;
  }

  // getOrder reads the id the same way it would off a declared
  // /:id route, so the middleware sets it up the same way.
  req.params.id = subPath;
  handlersBySubPath.item(req, res);
}
