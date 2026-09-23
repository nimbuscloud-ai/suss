# ALB request flow

Who serves GET https://shop.example.com/api/orders/123, hop by hop? A client calls the URL. An ALB listener rule matches `/api/orders/*` and forwards to a target group, and that target group is in front of the ECS service that runs the orders-app container. The app mounts an orders router at `/api/orders`, a dispatch middleware reads the sub-path, and the request reaches the `getOrder` handler, which returns `{ id, status }`.

GET `/api/health` asks the same question through a different listener rule. That rule forwards to a target group whose target is a Lambda function instead of an ECS service. A single reachability rule, still to be written, has to walk both paths the same way, from listener rule to target group to whatever is behind it, and reach a handler either way. A rule with a special case for one target kind fails on the other path.

Each kind of pattern also forwards to both kinds of target. The ECS side has a wildcard rule (`/api/orders/*`) and an exact one (`/api/orders/_health`, which is also the ALB health check). The Lambda side has an exact rule (`/api/health`) and a wildcard one (`/api/health/*`). A resolver that decides the backend from the kind of pattern, instead of from the target group's `TargetType`, picks the wrong backend for two of the four rules.
