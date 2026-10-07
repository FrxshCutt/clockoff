-- Runs once on first container start. Creates the integration-test database and the
-- citext extension (case-insensitive emails) in both databases.
CREATE DATABASE clockoff_test;
\connect clockoff
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\connect clockoff_test
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
