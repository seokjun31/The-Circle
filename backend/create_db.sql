-- Run this once to create the separate database for the FastAPI backend.
-- The existing 'interior_db' (Node.js server) is kept untouched.
--
-- Usage (as postgres superuser):
--   psql -U postgres -f create_db.sql
--   OR inside the docker container:
--   docker exec -it the-circle-db-1 psql -U user -c "CREATE DATABASE the_circle;"

SELECT 'CREATE DATABASE the_circle'
WHERE NOT EXISTS (
    SELECT FROM pg_database WHERE datname = 'the_circle'
)\gexec
