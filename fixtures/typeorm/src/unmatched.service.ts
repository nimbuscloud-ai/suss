// Repositories the pack leaves alone: one nothing injects, and one
// injected by a project decorator of the same name. The third is Nest's
// decorator imported under another name, which the pack reads as Nest's.

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
