-- Runs once, when the Postgres volume is first created.
-- The services connect as tb_app. It is deliberately NOT the owner of any table and cannot bypass RLS,
-- so the row-level security policies in db/migrations actually apply to every query the app makes.
CREATE ROLE tb_app LOGIN PASSWORD 'tb_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE testbench TO tb_app;
