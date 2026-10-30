-- BOQ Generator durable job and immutable snapshot metadata.
-- Snapshot documents and generated workbooks live in the dedicated private
-- object store; this database stores only their private object paths.
-- RLS is enabled in the following migration so both migrations ship as a
-- single deployment unit before any BOQ Generator route is mounted.

BEGIN;

CREATE TABLE IF NOT EXISTS public.boq_job (
  id                  text NOT NULL,
  employee_id         text NOT NULL,
  project_id          text NOT NULL,
  service_job_id      text,
  status              text NOT NULL DEFAULT 'DRAFT',
  data_status         text,
  production_mode     boolean,
  dxf_scale           double precision,
  scale_confirmed_by  text,
  scale_confirmed_at  timestamp(3),
  idempotency_key     text,
  revision            integer NOT NULL DEFAULT 1,
  settings_json       jsonb,
  input_files         jsonb NOT NULL,
  error_code          text,
  error_message       text,
  error_details       jsonb,
  started_at          timestamp(3),
  completed_at        timestamp(3),
  created_at          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          timestamp(3) NOT NULL,

  CONSTRAINT boq_job_pkey PRIMARY KEY (id),
  CONSTRAINT boq_job_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.employees(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT boq_job_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES public.project(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS boq_job_employee_id_idempotency_key_key
  ON public.boq_job (employee_id, idempotency_key);
CREATE INDEX IF NOT EXISTS boq_job_employee_id_created_at_idx
  ON public.boq_job (employee_id, created_at);
CREATE INDEX IF NOT EXISTS boq_job_project_id_created_at_idx
  ON public.boq_job (project_id, created_at);
CREATE INDEX IF NOT EXISTS boq_job_status_idx
  ON public.boq_job (status);

CREATE TABLE IF NOT EXISTS public.boq_snapshot (
  id                   text NOT NULL,
  boq_job_id           text NOT NULL,
  revision             integer NOT NULL,
  schema_version       text NOT NULL,
  kind                 text NOT NULL DEFAULT 'acs.boq.snapshot',
  service_version      text,
  data_status          text NOT NULL,
  production_mode      boolean NOT NULL,
  currency             text NOT NULL DEFAULT 'INR',
  totals_amount        decimal(15, 2),
  line_count           integer NOT NULL DEFAULT 0,
  withheld_count       integer NOT NULL DEFAULT 0,
  snapshot_blob_path   text NOT NULL,
  export_blob_path     text,
  dxf_scale            double precision,
  scale_confirmed_by   text,
  acknowledged_by_id   text,
  acknowledged_at      timestamp(3),
  saved_by_id          text NOT NULL,
  created_at           timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT boq_snapshot_pkey PRIMARY KEY (id),
  CONSTRAINT boq_snapshot_boq_job_id_revision_key UNIQUE (boq_job_id, revision),
  CONSTRAINT boq_snapshot_boq_job_id_fkey
    FOREIGN KEY (boq_job_id) REFERENCES public.boq_job(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS boq_snapshot_boq_job_id_idx
  ON public.boq_snapshot (boq_job_id);

COMMIT;