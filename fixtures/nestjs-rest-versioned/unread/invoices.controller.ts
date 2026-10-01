import { Controller, Get } from "@nestjs/common";

@Controller({ path: "invoices", version: "1" })
export class InvoicesController {
  @Get(":id")
  show() {
    return { version: 1 };
  }
}

@Controller("receipts")
export class ReceiptsController {
  @Get()
  list() {
    return [];
  }
}
