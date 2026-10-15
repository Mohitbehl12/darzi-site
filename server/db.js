// Postgres connection and schema. Tables are created on startup if missing.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false,
  max: 5,
});

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text UNIQUE NOT NULL,
  name        text,
  email       text,
  address     text,
  role        text NOT NULL DEFAULT 'customer',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          bigserial PRIMARY KEY,
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_codes (phone, created_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  rel         text,
  fit         text,
  sizes       text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- measurements, reference garment, fit memory
  photos      boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles (user_id);

CREATE TABLE IF NOT EXISTS designs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS designs_user_idx ON designs (user_id, created_at DESC);

CREATE SEQUENCE IF NOT EXISTS order_seq START 25001;

CREATE TABLE IF NOT EXISTS orders (
  id              text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  customer_name   text,
  profile_id      text,
  profile_name    text,
  spec            jsonb NOT NULL,
  measurements    jsonb NOT NULL,
  adj             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ref             jsonb,
  price           int NOT NULL,
  status          int NOT NULL DEFAULT 0,
  notes           text,
  locked          boolean NOT NULL DEFAULT false,
  payment_status  text NOT NULL DEFAULT 'pending',   -- pending | paid | test-paid | failed
  payment_ref     text,
  rzp_order_id    text,
  feedback        jsonb,
  eta             date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

CREATE TABLE IF NOT EXISTS order_events (
  id          bigserial PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status      int NOT NULL,
  note        text,
  by_user     uuid,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id    text,
  title       text NOT NULL,
  body        text,
  channel     text NOT NULL DEFAULT 'in-app',
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fabrics (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  color       text NOT NULL,
  stock_m     numeric(8,2) NOT NULL DEFAULT 0,
  reorder_m   numeric(8,2) NOT NULL DEFAULT 10,
  cost_per_m  int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, color)
);
`;

const SEED_FABRICS = [
  ['Cotton poplin', 'White', 120, 30, 180], ['Oxford cotton', 'Sky', 64, 20, 260], ['Linen', 'Beige', 48, 20, 520],
  ['Linen', 'Sage', 18, 20, 540], ['Linen', 'Terracotta', 26, 15, 540], ['Silk', 'Ivory', 22, 10, 1450],
  ['Mul cotton', 'Mint', 40, 15, 220], ['Chanderi', 'Maroon', 9, 10, 980], ['Wool blend', 'Midnight', 30, 12, 1650],
  ['Wool blend', 'Charcoal', 34, 12, 1650], ['Organza', 'Dusty Rose', 14, 10, 1100], ['Mashru silk', 'Rust', 7, 8, 1050],
];

async function migrate() {
  await pool.query(SCHEMA);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM fabrics');
  if (rows[0].n === 0) {
    for (const f of SEED_FABRICS) {
      await pool.query('INSERT INTO fabrics (name,color,stock_m,reorder_m,cost_per_m) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', f);
    }
  }
}

module.exports = { pool, migrate };
