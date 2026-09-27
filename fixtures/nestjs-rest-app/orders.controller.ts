// A controller whose routes take their status from the verb or from
// `@HttpCode`: Nest sends 201 for a POST, 200 for every other verb, and
// whatever `@HttpCode` says when a handler has one.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from "@nestjs/common";

const ACCEPTED = 202;

interface Order {
  reference: string;
  total: number;
}

declare const orders: {
  all(): Promise<Order[]>;
  create(input: Order): Promise<Order>;
  importMany(): Promise<number>;
  replace(reference: string, input: Order): Promise<void>;
  remove(reference: string): Promise<void>;
};

@Controller("orders")
export class OrdersController {
  @Get()
  list() {
    return orders.all();
  }

  @Post()
  create(@Body() input: Order) {
    return orders.create(input);
  }

  @Post("import")
  @HttpCode(200)
  importMany() {
    return orders.importMany();
  }

  @Put(":reference")
  @HttpCode(ACCEPTED)
  replace(@Param("reference") reference: string, @Body() input: Order) {
    return orders.replace(reference, input);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(":reference")
  async remove(@Param("reference") reference: string) {
    await orders.remove(reference);
  }
}
