// The global prefix leaves `/health` out, and `GET /orders/export` but
// not `POST /orders/export`.
import { Controller, Get, Post } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("health")
  check() {
    return { ok: true };
  }

  @Get("orders/export")
  exportOrders() {
    return [];
  }

  @Post("orders/export")
  scheduleExport() {
    return { scheduled: true };
  }
}
