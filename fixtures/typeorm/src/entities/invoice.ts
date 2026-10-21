import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "invoice_rows", schema: "billing" })
export class Invoice {
  @PrimaryColumn()
  id!: string;

  @Column()
  orderId!: string;

  @Column("int")
  amount!: number;
}
