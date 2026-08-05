// Process entry point for the orders-app ECS container.

import app from "./app";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`orders-app listening on ${port}`);
});
