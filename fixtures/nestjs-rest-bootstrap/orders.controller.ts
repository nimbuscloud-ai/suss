import { Controller, Get } from "@nestjs/common";

declare const orders: { all(): Promise<string[]> };

@Controller("orders")
export class OrdersController {
  @Get()
  list() {
    return orders.all();
  }
}
