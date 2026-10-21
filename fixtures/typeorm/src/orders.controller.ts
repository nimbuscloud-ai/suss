import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";

import { InvoicesService } from "./invoices.service";
import { OrdersService } from "./orders.service";
import { ReportsService } from "./reports.service";

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly reports: ReportsService,
  ) {}

  @Get()
  list() {
    return this.orders.listOpen();
  }

  @Get("totals")
  totals() {
    return this.reports.totals();
  }

  @Get(":id")
  async one(@Param("id") id: string) {
    const order = await this.orders.oneBy(id);
    return { order, invoices: await this.invoices.forOrder(id) };
  }

  @Post()
  create(@Body() body: { owner: string }) {
    return this.orders.insertOne(body.owner);
  }

  @Patch(":id/close")
  close(@Param("id") id: string) {
    return this.orders.close(id);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.orders.drop(id);
  }
}
