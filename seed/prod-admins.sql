-- Production admin template (SPEC Section 7 and deploy step 4).
-- Replace the example email with your Cloudflare Access email, add one staff
-- row and one app_users row per admin, then run:
--   npx wrangler d1 execute onboardflow-prod --remote --env production --file seed/prod-admins.sql
-- The app_users CHECK requires staff_id for every non-employee role, so each
-- admin needs a staff row (kind 'admin', ids P01, P02, ...).
INSERT INTO staff (id, email, display_name, kind, department, org_unit) VALUES
  ('P01', 'you@example.com', 'Production Admin', 'admin', NULL, NULL);
INSERT INTO app_users (email, role, employee_id, staff_id, active) VALUES
  ('you@example.com', 'admin', NULL, 'P01', 1);
