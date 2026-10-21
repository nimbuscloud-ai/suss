// Routes that reach every other repository call in the fixture, so each
// one is read as part of a handler's closure.

import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";

import type { Order } from "./entities/order";
import { GhostService } from "./ghost.service";
import { LinesService } from "./lines.service";
import { OrdersService } from "./orders.service";
import { ReportsService } from "./reports.service";
import {
  AliasedService,
  LookalikeService,
  PlainService,
} from "./unmatched.service";

@Controller("admin/orders")
export class AdminController {
  constructor(
    private readonly orders: OrdersService,
    private readonly lines: LinesService,
    private readonly reports: ReportsService,
    private readonly plain: PlainService,
    private readonly lookalike: LookalikeService,
    private readonly aliased: AliasedService,
    private readonly ghosts: GhostService,
  ) {}

  @Get("reads")
  async reads(@Query("owner") owner: string, @Query("id") id: string) {
    return [
      await this.orders.listColumns(),
      await this.orders.listEither(owner),
      await this.orders.page(0),
      await this.orders.one(id),
      await this.orders.oneOrFail(id),
      await this.orders.allBy(owner),
      await this.orders.openCount(),
      await this.orders.total(),
      await this.orders.has(id),
      await this.lines.forOrder(id),
    ];
  }

  @Post("writes/:id")
  async writes(@Param("id") id: string, @Body() order: Order) {
    await this.orders.addMany();
    await this.orders.add(order);
    await this.orders.upsertOne(id, 1);
    await this.orders.bump(id);
    await this.orders.lower(id);
    await this.orders.archive(id);
    await this.orders.unarchive(id);
    await this.orders.discard(order);
    await this.reports.closeStale(30);
    return this.orders.draft();
  }

  @Get("unmatched")
  async unmatched() {
    return [
      await this.plain.list(),
      await this.lookalike.list(),
      await this.aliased.list(),
      await this.ghosts.list(),
    ];
  }
}
