-- Runs once on first container start. Creates the integration-test database and the
-- citext extension (case-insensitive emails) in both databases.
CREATE DATABASE workmode_test;
\connect workmode
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\connect workmode_test
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
