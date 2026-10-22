-- The same two tables as db/schema.rb, as pg_dump writes them when an
-- app keeps db/structure.sql instead.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);

--
-- Name: order_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_state AS ENUM (
    'pending',
    'paid',
    'shipped'
);


SET default_tablespace = '';

--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    blob_id uuid NOT NULL,
    order_id bigint NOT NULL,
    filename character varying NOT NULL,
    created_at timestamp(6) without time zone NOT NULL
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id bigint NOT NULL,
    customer_id bigint NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    priority integer NOT NULL,
    quantity smallint NOT NULL,
    total numeric(10,2) NOT NULL,
    weight double precision,
    paid boolean DEFAULT false NOT NULL,
    public_id uuid NOT NULL,
    metadata jsonb,
    receipt bytea,
    tags character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    state public.order_state DEFAULT 'pending'::public.order_state NOT NULL,
    ship_on date,
    notes text,
    reference character varying NOT NULL,
    legacy_code character varying,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


CREATE SEQUENCE public.orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

CREATE INDEX index_attachments_on_order_id ON public.attachments USING btree (order_id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_rails_8b1a5d0a3c FOREIGN KEY (customer_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT fk_rails_2e6b0c4f1d FOREIGN KEY (order_id) REFERENCES public.orders(id);

SET search_path TO "$user", public;

INSERT INTO "schema_migrations" (version) VALUES
('20240601000000');
