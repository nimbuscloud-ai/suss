import { describe, expect, it } from "vitest";

import { readSqlSchema } from "./index.js";

/** Two tables the way pg_dump writes them, keys and sequences added afterwards. */
const PG_DUMP = `
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);

--
-- Name: order_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_state AS ENUM (
    'pending',
    'paid'
);

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.orders (
    id bigint NOT NULL,
    customer_id bigint NOT NULL,
    status character varying DEFAULT 'pending; or not'::character varying NOT NULL,
    quantity smallint NOT NULL,
    weight double precision,
    tags character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    notes text,
    created_at timestamp(6) without time zone NOT NULL
);

CREATE SEQUENCE public.orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;

CREATE TABLE audit.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id bigint
);

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY audit.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY audit.events
    ADD CONSTRAINT fk_rails_1 FOREIGN KEY (order_id) REFERENCES public.orders(id);

CREATE INDEX index_orders_on_customer_id ON public.orders USING btree (customer_id);

INSERT INTO "schema_migrations" (version) VALUES ('20240101000000');
`;

function tableIn(sql: string, name: string, dialect?: string) {
  const schema = readSqlSchema(sql, dialect === undefined ? {} : { dialect });
  return schema.tables.find((table) => table.name === name);
}

describe("readSqlSchema", () => {
  it("reads each table's columns, with the keys and defaults pg_dump adds afterwards", () => {
    const schema = readSqlSchema(PG_DUMP);

    expect(schema.tables.map((table) => table.name)).toEqual([
      "orders",
      "audit.events",
    ]);
    expect(schema.unread).toEqual([]);
    expect(schema.statements).toBe(6);
    expect(schema.tables[0]).toEqual({
      name: "orders",
      line: 23,
      columns: [
        {
          name: "id",
          type: "bigint",
          nullable: false,
          default: true,
          primary: true,
        },
        {
          name: "customer_id",
          type: "bigint",
          nullable: false,
          default: false,
        },
        {
          name: "status",
          type: "character varying",
          nullable: false,
          default: true,
        },
        { name: "quantity", type: "smallint", nullable: false, default: false },
        {
          name: "weight",
          type: "double precision",
          nullable: true,
          default: false,
        },
        {
          name: "tags",
          type: "character varying[]",
          nullable: false,
          default: true,
        },
        { name: "notes", type: "text", nullable: true, default: false },
        {
          name: "created_at",
          type: "timestamp",
          nullable: false,
          default: false,
        },
      ],
    });
  });

  it("keeps a table's schema when it is not public, and reads a foreign key added afterwards", () => {
    expect(tableIn(PG_DUMP, "audit.events")?.columns).toEqual([
      {
        name: "id",
        type: "uuid",
        nullable: false,
        default: true,
        primary: true,
      },
      {
        name: "order_id",
        type: "bigint",
        nullable: true,
        default: false,
        foreignKey: "orders",
      },
    ]);
  });

  it("reads a table the grammar rejects one column at a time, typing a column of an enum the dump creates as enum", () => {
    const sql = `
CREATE TYPE public.order_state AS ENUM ('pending', 'paid');

CREATE TABLE public.orders (
    id bigint NOT NULL,
    state public.order_state DEFAULT 'pending'::public.order_state NOT NULL,
    window_range int4range,
    embedding public.halfvec(1536) NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id)
);
`;
    const schema = readSqlSchema(sql);

    expect(schema.unread).toEqual([]);
    expect(schema.tables[0]?.columns).toEqual([
      {
        name: "id",
        type: "bigint",
        nullable: false,
        default: false,
        primary: true,
      },
      { name: "state", type: "enum", nullable: false, default: true },
      {
        name: "window_range",
        type: "int4range",
        nullable: true,
        default: false,
      },
      { name: "embedding", type: "halfvec", nullable: false, default: false },
    ]);
  });

  it("lists a column it still cannot read and leaves its nullability and default unstated", () => {
    const sql = `
CREATE TABLE public.people (
    id bigint NOT NULL,
    name text NOT NULL,
    slug text GENERATED ALWAYS AS (lower(name)) STORED
);
`;
    const schema = readSqlSchema(sql);

    expect(schema.tables[0]?.columns).toEqual([
      { name: "id", type: "bigint", nullable: false, default: false },
      { name: "name", type: "text", nullable: false, default: false },
      { name: "slug", type: "text" },
    ]);
    expect(schema.unread).toEqual([
      { line: 5, table: "people", column: "slug" },
    ]);
  });

  it("leaves a column's default unstated when the statement that sets one was not read", () => {
    const sql = `
CREATE TABLE public.users (
    id bigint NOT NULL
);

ALTER TABLE public.users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    CACHE 1
);
`;
    const schema = readSqlSchema(sql);

    expect(schema.tables[0]?.columns).toEqual([
      { name: "id", type: "bigint", nullable: false },
    ]);
    expect(schema.unread).toEqual([{ line: 6, table: "users", column: "id" }]);
  });

  it("counts a table with no list of columns as unread", () => {
    const sql = `
CREATE TABLE public.events_2024 PARTITION OF public.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
`;
    const schema = readSqlSchema(sql);

    expect(schema.tables).toEqual([]);
    expect(schema.unread).toEqual([
      { line: 2, table: "events_2024", column: null },
    ]);
    expect(schema.statements).toBe(1);
  });

  it("reads a key and the default a dropped default leaves behind", () => {
    const sql = `
CREATE TABLE public.memberships (
    user_id bigint NOT NULL,
    group_id bigint NOT NULL,
    role text DEFAULT 'member'::text
);

ALTER TABLE ONLY public.memberships ALTER COLUMN role DROP DEFAULT;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (user_id, group_id);
`;
    expect(tableIn(sql, "memberships")?.columns).toEqual([
      {
        name: "user_id",
        type: "bigint",
        nullable: false,
        default: false,
        primary: true,
      },
      {
        name: "group_id",
        type: "bigint",
        nullable: false,
        default: false,
        primary: true,
      },
      { name: "role", type: "text", nullable: true, default: false },
    ]);
  });

  it("reads a MySQL dump, where AUTO_INCREMENT is a default and DEFAULT NULL is none", () => {
    const sql = `
/*!40101 SET NAMES utf8mb4 */;
CREATE TABLE \`orders\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`paid\` tinyint(1) NOT NULL DEFAULT '0',
  \`state\` enum('pending','paid') NOT NULL DEFAULT 'pending',
  \`name\` varchar(255) DEFAULT NULL,
  \`user_id\` bigint DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`index_orders_on_user_id\` (\`user_id\`),
  CONSTRAINT \`fk_rails_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;
    expect(tableIn(sql, "orders", "mysql")?.columns).toEqual([
      {
        name: "id",
        type: "bigint",
        nullable: false,
        default: true,
        primary: true,
      },
      { name: "paid", type: "tinyint(1)", nullable: false, default: true },
      { name: "state", type: "enum", nullable: false, default: true },
      { name: "name", type: "varchar", nullable: true, default: false },
      {
        name: "user_id",
        type: "bigint",
        nullable: true,
        default: false,
        foreignKey: "users",
      },
    ]);
  });

  it("reads a key written on the column itself, and a serial type as a default", () => {
    const sql = `CREATE TABLE "Accounts" (id serial PRIMARY KEY, owner_id bigint REFERENCES users(id), note text DEFAULT NULL::text);`;
    expect(tableIn(sql, "Accounts")?.columns).toEqual([
      {
        name: "id",
        type: "serial",
        nullable: false,
        default: true,
        primary: true,
      },
      {
        name: "owner_id",
        type: "bigint",
        nullable: true,
        default: false,
        foreignKey: "users",
      },
      { name: "note", type: "text", nullable: true, default: false },
    ]);
  });

  it("lists each statement or definition it cannot read, and reads the rest", () => {
    const sql = `
CREATE TABLE (id integer);
CREATE TABLE public.typed OF public.address_type;
CREATE TABLE public.unclosed (id integer
;
CREATE TABLE public.bookings (
    id bigint NOT NULL,
    room public.room_code NOT NULL,
    EXCLUDE USING gist (room WITH =)
);
ALTER TABLE ONLY public.bookings ALTER COLUMN room TYPE text;
ALTER TABLE ONLY public.missing ADD CONSTRAINT missing_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.bookings ATTACH PARTITION public.bookings_2024 FOR VALUES FROM (1) TO (2);
`;
    const schema = readSqlSchema(sql);

    expect(schema.tables.map((table) => table.name)).toEqual(["bookings"]);
    expect(schema.tables[0]?.columns).toEqual([
      { name: "id", type: "bigint", nullable: false, default: false },
      { name: "room", type: "room_code", nullable: false, default: false },
    ]);
    expect(schema.unread).toEqual([
      { line: 2, table: null, column: null },
      { line: 3, table: "typed", column: null },
      { line: 4, table: "unclosed", column: null },
      { line: 9, table: "bookings", column: null },
      { line: 13, table: "bookings", column: null },
    ]);
    expect(schema.statements).toBe(7);
  });

  it("reads nothing for a dialect it has no grammar for", () => {
    expect(readSqlSchema(PG_DUMP, { dialect: "oracle" })).toEqual({
      tables: [],
      unread: [],
      statements: 0,
    });
  });
});
