import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Invoice } from "./entities/invoice";

export class InvoicesService {
  constructor(
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
  ) {}

  forOrder(orderId: string) {
    return this.invoices.find({
      where: { orderId },
      select: { id: true, amount: true },
    });
  }

  record(orderId: string, amount: number) {
    return this.invoices.save({ orderId, amount });
  }
}
