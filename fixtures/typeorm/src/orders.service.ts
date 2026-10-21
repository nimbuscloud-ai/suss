// Every repository method group the pack reads, on a repository Nest
// injects.

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Order } from "./entities/order";

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  listOpen() {
    return this.orders.find({
      where: { status: "open" },
      select: { id: true, total: true },
    });
  }

  listColumns() {
    return this.orders.find({ select: ["id", "status"] });
  }

  listEither(owner: string) {
    return this.orders.find({ where: [{ status: "open" }, { owner }] });
  }

  page(skip: number) {
    return this.orders.findAndCount({ where: { owner: "a" }, skip, take: 20 });
  }

  one(id: string) {
    return this.orders.findOne({ where: { id } });
  }

  oneOrFail(id: string) {
    return this.orders.findOneOrFail({ where: { id } });
  }

  oneBy(id: string) {
    return this.orders.findOneBy({ id });
  }

  allBy(owner: string) {
    return this.orders.findBy({ owner });
  }

  openCount() {
    return this.orders.countBy({ status: "open" });
  }

  total() {
    return this.orders.count();
  }

  has(id: string) {
    return this.orders.exists({ where: { id } });
  }

  close(id: string) {
    return this.orders.update({ id }, { status: "closed" });
  }

  addMany() {
    return this.orders.save([{ status: "open" }, { total: 3 }]);
  }

  add(order: Order) {
    return this.orders.save(order);
  }

  insertOne(owner: string) {
    return this.orders.insert({ owner, status: "new" });
  }

  upsertOne(id: string, total: number) {
    return this.orders.upsert({ id, total }, ["id"]);
  }

  bump(id: string) {
    return this.orders.increment({ id }, "total", 1);
  }

  lower(id: string) {
    return this.orders.decrement({ id }, "total", 1);
  }

  drop(id: string) {
    return this.orders.delete({ id });
  }

  archive(id: string) {
    return this.orders.softDelete({ id });
  }

  unarchive(id: string) {
    return this.orders.restore({ id });
  }

  discard(order: Order) {
    return this.orders.remove(order);
  }

  // Makes an entity in memory, which touches no table.
  draft() {
    return this.orders.create({});
  }
}
