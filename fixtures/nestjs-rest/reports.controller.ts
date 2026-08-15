import { Controller, Get } from "@nestjs/common";

import { REPORTS_BASE_PATH } from "./paths";

// The prefix arrives through an imported constant, which used to read
// as an empty string and mount the controller at root.
@Controller(REPORTS_BASE_PATH)
export class ReportsController {
  @Get("summary")
  summary(): { rows: number } {
    return { rows: 0 };
  }
}
