// Every service is called on its own class, `CreateInvoice.call(args)`,
// and runs the statics written here with `this` set to that class.

import { db } from "./db";

type Args = Record<string, unknown>;

export class BaseService {
  constructor(protected readonly args: Args) {}

  static call(args: Args) {
    return new this(args).run();
  }

  static callLogged(args: Args) {
    const service = new this(args);
    return service.runWithLog();
  }

  run(): Promise<void> {
    throw new Error("not implemented");
  }

  runWithLog() {
    this.logStart();
    return this.run();
  }

  logStart() {}
}

export class CreateInvoice extends BaseService {
  override run() {
    return db.insert("invoices", { amount: this.args.amount });
  }
}

export class VoidInvoice extends BaseService {
  override run() {
    return db.update("invoices", { id: this.args.id }, { status: "voided" });
  }
}
