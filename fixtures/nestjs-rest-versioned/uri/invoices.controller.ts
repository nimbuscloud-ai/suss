// A route serves the versions its own `@Version` states, or else its
// controller's, or else the application's default.
import {
  Controller,
  Get,
  Post,
  VERSION_NEUTRAL,
  Version,
} from "@nestjs/common";

declare const invoices: { all(): Promise<string[]>; one(id: string): string };

@Controller({ path: "invoices", version: ["2", "3"] })
export class InvoicesController {
  @Get()
  list() {
    return invoices.all();
  }

  @Version("4")
  @Get(":id")
  show() {
    return invoices.one("id");
  }

  @Version(VERSION_NEUTRAL)
  @Get("status")
  status() {
    return { ok: true };
  }
}

@Controller("receipts")
export class ReceiptsController {
  @Post()
  create() {
    return { created: true };
  }
}
