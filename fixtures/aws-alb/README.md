# ALB request flow

Who serves GET https://shop.example.com/api/orders/123, hop by hop? A client calls the URL, an ALB listener rule matches `/api/orders/*` and forwards to a target group, and that target group sits in front of the ECS service running the orders-app container. The app mounts an orders router at `/api/orders`, a dispatch middleware reads the sub-path, and it resolves to the `getOrder` handler, which returns `{ id, status }`.

GET `/api/health` asks the same shape of question through a different listener rule, one that forwards to a target group whose target is a Lambda function instead of an ECS service. One future reachability rule has to walk both paths the same way, from listener rule to target group to whatever backs it, and land on a handler either way. A rule that special cases either target kind fails the other path.
