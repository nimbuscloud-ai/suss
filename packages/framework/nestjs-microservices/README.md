# @suss/framework-nestjs-microservices

Reads NestJS microservice handlers: methods on a `@Controller()` class
decorated with `@EventPattern("order.placed")` or
`@MessagePattern("get.order")`. Each handler becomes a message-bus
consumer on the channel in its decorator, and pairs against whatever
produces on that channel.

```bash
suss extract -f nestjs-microservices
```

The transport is wired at bootstrap, so the handler's file never
mentions the broker. The pack assumes NATS. If the project uses a
different transport, set it in config:

```bash
suss extract -f nestjs-microservices=config.json
```

```json
{ "transport": "kafka" }
```

A channel passed as a constant resolves to the string it was set to.
The pack does not read an object-form pattern such as
`@MessagePattern({ cmd: "sum" })` yet. suss still records that handler
as a consumer on the wire, with no channel name.

Two more cases are not read yet. `@Payload("field")` does not narrow
the input, so every payload becomes one input. An `@MessagePattern`
handler's return value is the reply, and nothing pairs that reply with
the caller waiting for it.
