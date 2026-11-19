-- Run in the Supabase SQL Editor after migrations/001_reflexia.sql.
-- Creates one direct shared activity with equal permissions for every participant.
-- The result contains sessionId + invitationToken for public/config.js or the shared URL.
-- Keep the IDs aligned with ATTACKS in src/catalog.js. Original images stay unchanged.
select reflexia_private.create_session(
  24,
  '["verification","governance","privacy","security"]'::jsonb
);
