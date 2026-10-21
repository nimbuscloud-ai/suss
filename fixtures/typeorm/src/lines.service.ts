// The constructor assigns the injected repository to a field itself.

import { InjectRepository } from "@nestjs/typeorm";

import { OrderLine } from "./entities/orderLine";

export class LinesService {
  private readonly lines: any;

  constructor(@InjectRepository(OrderLine) lines: any) {
    this.lines = lines;
  }

  forOrder(orderId: string) {
    return this.lines.find({ where: { orderId } });
  }
}
