// The object-array form of the same thing. The array is bound to a
// name above the call, which reads the same as writing it out in the
// argument. Routes nest under `children` two deep, with an index child
// answering its parent's path, and the array spreads in routes another
// module declares, which this run does not enumerate.

import { createBrowserRouter } from "react-router-dom";

import { extraRoutes } from "./extraRoutes";
import {
  Billing,
  Home,
  Invoice,
  InvoiceLines,
  InvoicesIndex,
  Shell,
} from "./pages";

const routes = [
  { path: "/", element: <Home /> },
  {
    path: "/billing",
    element: <Shell />,
    children: [
      { index: true, element: <Billing /> },
      {
        path: "invoices",
        element: <InvoicesIndex />,
        children: [
          { path: ":invoiceId", element: <Invoice /> },
          { path: ":invoiceId/lines", element: <InvoiceLines /> },
        ],
      },
    ],
  },
  ...extraRoutes,
];

export const router = createBrowserRouter(routes);
