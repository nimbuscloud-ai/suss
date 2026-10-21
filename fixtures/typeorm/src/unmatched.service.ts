// Repositories the pack leaves alone today: one nothing injects, one
// injected by a project decorator of the same name, and one injected
// through Nest's decorator imported under another name.

import { InjectRepository as InjectNest } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { InjectRepository } from "./decorators";
import { Order } from "./entities/order";

export class PlainService {
  constructor(private readonly orders: Repository<Order>) {}

  list() {
    return this.orders.find();
  }
}

export class LookalikeService {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  list() {
    return this.orders.find();
  }
}

export class AliasedService {
  constructor(@InjectNest(Order) private readonly orders: Repository<Order>) {}

  list() {
    return this.orders.find();
  }
}
