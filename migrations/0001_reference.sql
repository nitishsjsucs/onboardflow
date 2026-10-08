-- Reference data: the eight onboarding stages and the ten employee checklist
-- templates. Mirrors STAGES and TASK_TEMPLATES in src/shared/stages.ts
-- (asserted equal by test/worker/stages.test.ts).
CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal BETWEEN 1 AND 8),
  name TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('people_ops','it','facilities','manager')),
  gate TEXT NOT NULL CHECK (gate IN ('auto','employee_tasks','approval'))
);
INSERT INTO stages (id, ordinal, name, owner, gate) VALUES
  ('intake',1,'Pre-boarding intake','people_ops','auto'),
  ('paperwork',2,'Paperwork and verification','people_ops','employee_tasks'),
  ('manager_approval',3,'Manager approval of equipment and access','manager','approval'),
  ('it_provisioning',4,'IT provisioning','it','auto'),
  ('facilities_setup',5,'Facilities setup','facilities','auto'),
  ('provisioning_verification',6,'Cross-system provisioning check','it','auto'),
  ('orientation',7,'Orientation and day one','people_ops','employee_tasks'),
  ('closeout',8,'People Ops sign-off','people_ops','approval');

CREATE TABLE task_templates (
  key TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES stages(id),
  assignee TEXT NOT NULL CHECK (assignee IN ('employee','people_ops','it','facilities','manager')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  due_offset_days INTEGER NOT NULL,          -- relative to employees.start_date
  sort INTEGER NOT NULL
);
INSERT INTO task_templates (key, stage_id, assignee, title, description, due_offset_days, sort) VALUES
  ('offer_docs','paperwork','employee','Sign offer documents','Review and sign the offer letter and confidentiality agreement.',-14,1),
  ('i9_section1','paperwork','employee','Complete Form I-9 Section 1','Fill in Section 1 of Form I-9 (synthetic, no real documents).',-7,2),
  ('w4','paperwork','employee','Submit Form W-4','Provide federal tax withholding elections.',-7,3),
  ('direct_deposit','paperwork','employee','Set up direct deposit','Enter payroll deposit preferences (synthetic data only).',-7,4),
  ('emergency_contact','paperwork','employee','Add an emergency contact','Name one emergency contact.',-7,5),
  ('badge_photo','paperwork','employee','Upload a badge photo','Provide a photo for the building badge.',-10,6),
  ('attend_orientation','orientation','employee','Attend orientation','Join the new hire orientation session.',1,7),
  ('enroll_mfa','orientation','employee','Enroll in MFA','Register a second factor for your account.',0,8),
  ('security_training','orientation','employee','Complete security training','Finish the security awareness module.',3,9),
  ('meet_buddy','orientation','employee','Meet your onboarding buddy','Schedule a first chat with your buddy.',5,10);
