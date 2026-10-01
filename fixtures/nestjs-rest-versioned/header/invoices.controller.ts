import { Controller, Get } from "@nestjs/common";

@Controller({ path: "invoices", version: "1" })
export class InvoicesV1Controller {
  @Get(":id")
  show() {
    return { version: 1 };
  }
}

@Controller({ path: "invoices", version: "2" })
export class InvoicesV2Controller {
  @Get(":id")
  show() {
    return { version: 2 };
  }
}
