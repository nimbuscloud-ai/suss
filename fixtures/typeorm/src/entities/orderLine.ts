// @Entity has no argument, so TypeORM takes the table from the class
// name in snake case.

import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class OrderLine {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  orderId!: string;

  @Column("int")
  quantity!: number;
}
