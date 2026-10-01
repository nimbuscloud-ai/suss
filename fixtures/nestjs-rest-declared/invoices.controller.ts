// The swagger decorators list statuses the generated spec declares,
// whether or not a path in the handler sends them.
import { Controller, Get, HttpStatus, Post } from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

declare const invoices: { one(id: string): Promise<unknown> };

@ApiUnauthorizedResponse()
@Controller("invoices")
export class InvoicesController {
  @ApiNotFoundResponse()
  @Get(":id")
  show() {
    return invoices.one("id");
  }

  @ApiResponse({ status: HttpStatus.OK, description: "Already uploaded" })
  @ApiResponse({ status: 201, description: "Uploaded" })
  @Post()
  upload() {
    return { uploaded: true };
  }
}
