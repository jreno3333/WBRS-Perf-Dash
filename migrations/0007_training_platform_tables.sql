-- Training Platform Sync (Phase 1) — read-only mirror of in-house LMS data.
-- Tables are created here so a fresh deploy/clean DB has them on startup.

CREATE TABLE IF NOT EXISTS training_courses (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  external_course_id text NOT NULL UNIQUE,
  title text NOT NULL,
  category text,
  total_modules integer,
  synced_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_modules (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  external_module_id text NOT NULL UNIQUE,
  external_course_id text NOT NULL,
  title text NOT NULL,
  category text,
  default_due_days integer,
  synced_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_employee_progress (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar NOT NULL,
  external_employee_id text NOT NULL,
  external_course_id text NOT NULL,
  percent_complete numeric(5,2) NOT NULL DEFAULT 0,
  score numeric(5,2),
  status text,
  due_date text,
  completed_at timestamp,
  synced_at timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS training_emp_course_idx
  ON training_employee_progress (employee_id, external_course_id);

CREATE TABLE IF NOT EXISTS training_module_progress (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar NOT NULL,
  external_employee_id text NOT NULL,
  external_module_id text NOT NULL,
  status text NOT NULL,
  due_date text,
  score numeric(5,2),
  completed_at timestamp,
  synced_at timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS training_emp_module_idx
  ON training_module_progress (employee_id, external_module_id);

CREATE TABLE IF NOT EXISTS training_certifications (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id varchar NOT NULL,
  external_employee_id text NOT NULL,
  certification_key text NOT NULL,
  name text NOT NULL,
  earned_at timestamp,
  expires_at timestamp,
  synced_at timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS training_emp_cert_idx
  ON training_certifications (employee_id, certification_key);

CREATE TABLE IF NOT EXISTS training_sync_status (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  records_synced jsonb NOT NULL,
  unmapped_external_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  error_message text,
  ran_at timestamp DEFAULT now()
);
