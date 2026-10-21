// The connection settings `suss init` reads the database type from: a
// data source and an async module factory.

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { Invoice } from "./entities/invoice";
import { Order } from "./entities/order";
import { OrderLine } from "./entities/orderLine";
import { OrdersController } from "./orders.controller";

export const dataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [Order, OrderLine, Invoice],
});

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: "postgres",
        url: process.env.DATABASE_URL,
        autoLoadEntities: true,
      }),
    }),
    TypeOrmModule.forFeature([Order, OrderLine, Invoice]),
  ],
  controllers: [OrdersController],
})
export class AppModule {}
