import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("orders")
export class Order {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  status!: string;

  @Column()
  owner!: string;

  @Column("int")
  total!: number;
}
