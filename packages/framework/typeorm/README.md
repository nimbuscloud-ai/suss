# @suss/framework-typeorm

This pack records which tables a NestJS service reads and writes through the TypeORM repositories NestJS injects into it.

## What this package is

A pattern pack. It matches calls on an injected repository and records the same `storage-access` effects the other storage packs do, so a writer and a reader of the same table become two ends of one boundary.

```ts
import { typeormFramework } from "@suss/framework-typeorm";

const pack = typeormFramework();
```

The pack is a declaration written with `@suss/recognize`. It lists the methods, the decorator the repository comes from, and where each argument is read. The table name and the rules that read a condition, a `select` and a saved entity are code.

## How it settles a call

NestJS builds the repository and hands it to the constructor:

```ts
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  open() {
    return this.orders.find({ where: { status: "open" }, select: ["id"] });
  }
}
```

Nothing the project wrote builds `this.orders`, so the pack says that `@nestjs/typeorm`'s `InjectRepository` supplies the parameter it decorates. The resolution store then reads `this.orders` as the `InjectRepository(Order)` call, and a call counts when its receiver came from that call. A field the constructor assigns from the parameter, `this.orders = orders`, reads the same way.

The decorator is matched by the module it was imported from, so a project decorator called `InjectRepository` does not count. The pack needs neither library installed: it reads the imports the source writes.

## The table a call reaches

The table comes from the entity class passed to `InjectRepository`, checked in TypeORM's own order:

1. The name `@Entity` is given: `@Entity("orders")` or `@Entity({ name: "orders" })`.
2. TypeORM's default naming, which turns the class name into snake case: `OrderLine` is `order_line`.

When the entity cannot be found, the call is still recorded, with no table.

## What each call contributes

| Method | Kind | Selector | Fields |
| --- | --- | --- | --- |
| `find`, `findOne`, `findOneOrFail`, `findAndCount` | read | the keys of `where` | `select`, or `*` |
| `count`, `exists` | read | the keys of `where` | none |
| `findBy`, `findOneBy`, `findOneByOrFail`, `findAndCountBy` | read | the keys of the argument | `*` |
| `countBy`, `existsBy` | read | the keys of the argument | none |
| `save`, `insert`, `upsert` | write | none | the keys of the entity, or of every entity in a list |
| `update` | write | the keys of the condition | the keys of the partial entity |
| `increment`, `decrement` | write | the keys of the condition | the column named |
| `delete`, `softDelete`, `restore` | write | the keys of the condition | `*` |
| `remove`, `softRemove` | write | none | `*` |

A `where` written as a list of conditions selects on the keys of all of them. A saved entity that is not an object literal counts as writing every column.

`query` on a data source injected with `InjectDataSource`, or an entity manager injected with `InjectEntityManager`, is read as SQL, the way the Prisma pack reads `$queryRaw`.

## Options

`-f typeorm=config.json` may set `storageSystem`, `"postgresql"` when unset, and `scope`, `"default"` when unset. Both have to match the other side of the boundary for the calls to pair.

## Out of scope for now

- **`create`**, which builds an entity in memory and touches no table.
- **`createQueryBuilder`**. The builder chain decides whether the query reads or writes, and the pack does not follow it.
- **`manager` and `transaction`** on a repository, and **`getRepository(Entity)`** on a data source.
- **A repository the project builds itself**, with `dataSource.getRepository(Entity)` or a custom repository class.
- **The entity's `schema` option.** The table is recorded without it.
- **`relations`** in a find. A read across a relation is not resolved to the table on the other side.
