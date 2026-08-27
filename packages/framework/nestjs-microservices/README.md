# @suss/framework-nestjs-microservices

Reads NestJS microservice handlers: methods on a `@Controller()` class
decorated with `@EventPattern("order.placed")` or
`@MessagePattern("get.order")`. Each handler becomes a message-bus
consumer on the channel its decorator states, and pairs against
whatever produces on that channel.

```bash
suss extract -f nestjs-microservices
```

The transport is wired at bootstrap, so the handler's file never says
which broker. The pack defaults to NATS; a project on another
transport says so through config:

```bash
suss extract -f nestjs-microservices=config.json
```

```json
{ "transport": "kafka" }
```

A channel passed as a constant resolves to its written string. An
object-form pattern (`@MessagePattern({ cmd: "sum" })`) is a
structured key this pack does not read yet: the handler is still
recorded as a consumer on the wire, with its channel unnamed.
