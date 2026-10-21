// Raw SQL through an injected data source and entity manager.

import { InjectDataSource, InjectEntityManager } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";

export class ReportsService {
  constructor(
    @InjectDataSource() private readonly source: DataSource,
    @InjectEntityManager() private readonly manager: EntityManager,
  ) {}

  totals() {
    return this.source.query(
      "SELECT o.owner, SUM(i.amount) FROM orders o JOIN invoice_rows i ON i.order_id = o.id GROUP BY o.owner",
    );
  }

  closeStale(days: number) {
    return this.manager.query(
      "UPDATE orders SET status = 'stale' WHERE created_at < NOW() - $1 * INTERVAL '1 day'",
      [days],
    );
  }
}
