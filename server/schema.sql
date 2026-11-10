PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('PRESALES','MANAGER','VP','ADMIN')),
  manager_id TEXT REFERENCES users(id),
  position_code TEXT CHECK (position_code IS NULL OR position_code IN ('RND_MANAGER','GENERAL_MANAGER')),
  phone TEXT,
  email TEXT,
  regions_json TEXT NOT NULL DEFAULT '[]',
  home_city TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_manager_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  previous_manager_id TEXT REFERENCES users(id),
  new_manager_id TEXT NOT NULL REFERENCES users(id),
  changed_by TEXT REFERENCES users(id),
  reason TEXT NOT NULL,
  effective_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS user_manager_history_user_idx ON user_manager_history(user_id, effective_at);

CREATE TABLE IF NOT EXISTS customer_dictionary_options (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('SOURCE','TYPE')),
  value TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  used_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  short_name TEXT,
  source TEXT,
  customer_type TEXT,
  registered_on TEXT,
  status TEXT NOT NULL CHECK (status IN ('初期接洽','现场调研','方案&报价','报价完成&商务洽谈','合同签订完成','丢标','中止')),
  need_summary TEXT NOT NULL,
  industry TEXT,
  province TEXT,
  city TEXT,
  district TEXT,
  address TEXT,
  longitude REAL,
  latitude REAL,
  map_x_percent REAL CHECK (map_x_percent >= 0 AND map_x_percent <= 100),
  map_y_percent REAL CHECK (map_y_percent >= 0 AND map_y_percent <= 100),
  map_asset_sha256 TEXT,
  summary TEXT,
  notes TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customers_owner_idx ON customers(owner_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  department TEXT,
  title TEXT,
  mobile TEXT,
  wechat TEXT,
  email TEXT,
  decision_role TEXT,
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS contacts_customer_idx ON contacts(customer_id, updated_at);

CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  project_id TEXT REFERENCES projects(id),
  contact_id TEXT REFERENCES contacts(id),
  method TEXT NOT NULL CHECK (method IN ('PHONE','WECHAT','ONSITE','MEETING','EMAIL','OTHER')),
  occurred_at TEXT NOT NULL,
  occurred_precision TEXT NOT NULL DEFAULT 'DATETIME' CHECK (occurred_precision IN ('DATETIME','DAY')),
  is_historical INTEGER NOT NULL DEFAULT 0 CHECK (is_historical IN (0,1)),
  participants_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  customer_feedback TEXT,
  next_action TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS followups_customer_idx ON followups(customer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS followup_revisions (
  id TEXT PRIMARY KEY,
  followup_id TEXT NOT NULL REFERENCES followups(id),
  before_json TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_collaborators (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, user_id)
);

CREATE TABLE IF NOT EXISTS customer_transfers (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  previous_owner_id TEXT NOT NULL REFERENCES users(id),
  new_owner_id TEXT NOT NULL REFERENCES users(id),
  operated_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  summary TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_templates (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS surveys (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  previous_survey_id TEXT REFERENCES surveys(id),
  template_id TEXT NOT NULL REFERENCES survey_templates(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COMPLETED')),
  response_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  draft_etag INTEGER NOT NULL DEFAULT 0,
  draft_saved_at TEXT,
  approval_stage TEXT CHECK (approval_stage IS NULL OR approval_stage IN ('MANAGER','GENERAL_MANAGER','VP')),
  created_by TEXT NOT NULL REFERENCES users(id),
  completed_by TEXT REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS surveys_customer_idx ON surveys(customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS survey_revisions (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  revision INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE (survey_id, revision)
);

CREATE TABLE IF NOT EXISTS sop_documents (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  current_version_id TEXT REFERENCES sop_versions(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sop_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES sop_documents(id),
  version_number TEXT NOT NULL,
  title TEXT NOT NULL,
  roles_json TEXT NOT NULL DEFAULT '[]',
  stages_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  body_text TEXT NOT NULL,
  update_summary TEXT NOT NULL,
  source_note TEXT,
  published_by TEXT REFERENCES users(id),
  published_at TEXT NOT NULL,
  UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS sop_versions_document_idx ON sop_versions(document_id, published_at DESC);

CREATE TABLE IF NOT EXISTS stored_files (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('IMPORT_JOB','SURVEY','QUOTE_VERSION','CUSTOMER')),
  entity_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('SOURCE_XLSX','SURVEY_REPORT_DOCX','APPROVED_QUOTE_DOCX','FOLLOWUPS_DOCX','BUSINESS_ATTACHMENT')),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stored_files_entity_idx ON stored_files(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_attachments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('CUSTOMER','FOLLOWUP','SURVEY','SURVEY_QUESTION','QUOTE_VERSION')),
  target_id TEXT NOT NULL,
  target_key TEXT NOT NULL DEFAULT '',
  current_version_id TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  deleted_by TEXT REFERENCES users(id),
  deleted_at TEXT,
  deletion_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS business_attachments_target_idx ON business_attachments(target_type, target_id, target_key, is_deleted, created_at);
CREATE INDEX IF NOT EXISTS business_attachments_customer_idx ON business_attachments(customer_id, is_deleted, created_at);

CREATE TABLE IF NOT EXISTS business_attachment_versions (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES business_attachments(id),
  revision INTEGER NOT NULL,
  file_id TEXT NOT NULL REFERENCES stored_files(id),
  request_key TEXT UNIQUE,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (attachment_id, revision)
);

CREATE INDEX IF NOT EXISTS business_attachment_versions_attachment_idx ON business_attachment_versions(attachment_id, revision DESC);

CREATE TABLE IF NOT EXISTS business_attachment_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('SURVEY_COMPLETION','QUOTE_SUBMISSION')),
  snapshot_owner_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  attachment_id TEXT NOT NULL REFERENCES business_attachments(id),
  attachment_version_id TEXT NOT NULL REFERENCES business_attachment_versions(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_key TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (snapshot_kind, snapshot_owner_id, attachment_version_id)
);

CREATE INDEX IF NOT EXISTS business_attachment_snapshots_owner_idx ON business_attachment_snapshots(snapshot_kind, snapshot_owner_id, created_at);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  file_id TEXT REFERENCES stored_files(id),
  target_type TEXT NOT NULL CHECK (target_type = 'CUSTOMER'),
  status TEXT NOT NULL CHECK (status IN ('UPLOADED','PREVIEWED','PARTIAL','COMPLETED')),
  sheet_name TEXT,
  header_row INTEGER,
  field_mapping_json TEXT NOT NULL DEFAULT '{}',
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_rows (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  normalized_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('VALID','DUPLICATE','FAILED','IMPORTED')),
  errors_json TEXT NOT NULL DEFAULT '[]',
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  imported_customer_id TEXT REFERENCES customers(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, row_number)
);

CREATE INDEX IF NOT EXISTS import_rows_job_idx ON import_rows(job_id, status, row_number);

CREATE TABLE IF NOT EXISTS customer_import_origins (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  import_row_id TEXT NOT NULL REFERENCES import_rows(id),
  source_file_id TEXT NOT NULL REFERENCES stored_files(id),
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  original_registered_on TEXT NOT NULL,
  original_status TEXT NOT NULL,
  mapped_status TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('CREATED','MERGED','FORCED_CREATED')),
  operated_by TEXT NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL,
  force_reason TEXT,
  distinguishing_basis_type TEXT,
  distinguishing_basis TEXT,
  UNIQUE (import_job_id, import_row_id)
);

CREATE INDEX IF NOT EXISTS customer_import_origins_customer_idx ON customer_import_origins(customer_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS followup_import_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  cell_reference TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  paragraph_number INTEGER NOT NULL,
  raw_date TEXT NOT NULL,
  raw_method TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  occurred_on TEXT,
  method TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, source_key)
);

CREATE TABLE IF NOT EXISTS followup_import_origins (
  source_key TEXT PRIMARY KEY,
  followup_id TEXT NOT NULL UNIQUE REFERENCES followups(id),
  customer_origin_id TEXT NOT NULL REFERENCES customer_import_origins(id),
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  source_file_id TEXT NOT NULL REFERENCES stored_files(id),
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  cell_reference TEXT NOT NULL,
  paragraph_number INTEGER NOT NULL,
  raw_date TEXT NOT NULL,
  raw_method TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  operated_by TEXT NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL,
  UNIQUE (source_sha256, sheet_name, cell_reference, paragraph_number)
);

CREATE TABLE IF NOT EXISTS visit_import_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  previewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, source_key)
);

CREATE INDEX IF NOT EXISTS visit_import_entries_job_idx ON visit_import_entries(job_id, source_row_number);

CREATE TABLE IF NOT EXISTS visit_import_origins (
  source_key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  source_file_id TEXT NOT NULL REFERENCES stored_files(id),
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('CREATED','MERGED','FORCED_CREATED')),
  operated_by TEXT NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL,
  UNIQUE (source_sha256, sheet_name, source_row_number)
);

CREATE INDEX IF NOT EXISTS visit_import_origins_customer_idx ON visit_import_origins(customer_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS visit_import_decisions (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES visit_import_origins(source_key),
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  request_hash TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  operated_by TEXT NOT NULL REFERENCES users(id),
  operated_at TEXT NOT NULL,
  UNIQUE (source_key, request_hash)
);

CREATE INDEX IF NOT EXISTS visit_import_decisions_source_idx ON visit_import_decisions(source_key, operated_at);

CREATE TABLE IF NOT EXISTS weekly_report_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  cells_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  previewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, source_key)
);

CREATE INDEX IF NOT EXISTS weekly_report_entries_job_idx ON weekly_report_entries(job_id, source_row_number);

CREATE TABLE IF NOT EXISTS weekly_report_origins (
  source_key TEXT PRIMARY KEY,
  first_import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  source_file_id TEXT NOT NULL REFERENCES stored_files(id),
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  cells_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  first_confirmed_by TEXT NOT NULL REFERENCES users(id),
  first_confirmed_at TEXT NOT NULL,
  UNIQUE (source_sha256, sheet_name, source_row_number)
);

CREATE TABLE IF NOT EXISTS weekly_report_decisions (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES weekly_report_origins(source_key),
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  request_hash TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  business_type TEXT NOT NULL,
  date_handling TEXT NOT NULL CHECK (date_handling IN ('SOURCE_CELL','NOT_RECORDED','NOT_REQUIRED')),
  date_cell_reference TEXT,
  content_handling TEXT NOT NULL CHECK (content_handling IN ('SOURCE_CELLS','NOT_RECORDED','NOT_REQUIRED')),
  content_cell_references_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  operated_by TEXT NOT NULL REFERENCES users(id),
  operated_at TEXT NOT NULL,
  UNIQUE (source_key, request_hash)
);

CREATE INDEX IF NOT EXISTS weekly_report_decisions_source_idx ON weekly_report_decisions(source_key, operated_at);
CREATE INDEX IF NOT EXISTS weekly_report_decisions_customer_idx ON weekly_report_decisions(customer_id, operated_at DESC);

CREATE TABLE IF NOT EXISTS customer_duplicate_relations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  related_customer_id TEXT NOT NULL REFERENCES customers(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('SUSPECTED_DUPLICATE','SAME_NAME_DISTINCT')),
  import_origin_id TEXT REFERENCES customer_import_origins(id),
  reason TEXT NOT NULL,
  distinguishing_basis_type TEXT,
  distinguishing_basis TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (customer_id <> related_customer_id)
);

CREATE INDEX IF NOT EXISTS customer_duplicate_relations_customer_idx ON customer_duplicate_relations(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  related_type TEXT,
  related_id TEXT,
  title TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  original_remind_at TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('LOW','MEDIUM','HIGH')),
  assignee_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('SELF','LEADER')),
  assigned_by TEXT NOT NULL REFERENCES users(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','CANCELED','UNABLE_PENDING')),
  completed_at TEXT,
  handled_by TEXT REFERENCES users(id),
  handling_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reminders_assignee_idx ON reminders(assignee_id, status, remind_at);
CREATE INDEX IF NOT EXISTS reminders_assigner_idx ON reminders(assigned_by, status, remind_at);

CREATE TABLE IF NOT EXISTS reminder_events (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED','ASSIGNED','POSTPONED','COMPLETED','CANCELED','UNABLE_REPORTED','CLOSE_CONFIRMED','RESTORED','REASSIGNED')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reminder_events_reminder_idx ON reminder_events(reminder_id, created_at);

CREATE TABLE IF NOT EXISTS quote_manager_handoffs (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  previous_manager_id TEXT REFERENCES users(id),
  new_manager_id TEXT NOT NULL REFERENCES users(id),
  operated_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('CUSTOMER_TRANSFER','USER_MANAGER_CHANGE')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quote_handoffs_version_idx ON quote_manager_handoffs(quote_version_id, created_at);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  quote_number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  current_version_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_versions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_MANAGER','MANAGER_RETURNED','PENDING_VP','VP_RETURNED','APPROVED','VOID')),
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  subtotal_untaxed_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_taxed_cents INTEGER NOT NULL DEFAULT 0,
  final_discount_cents INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  snapshot_hash TEXT,
  submitted_at TEXT,
  locked_at TEXT,
  draft_etag INTEGER NOT NULL DEFAULT 0,
  draft_saved_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (quote_id, revision)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT 'SUMMARY' CHECK (section IN ('SUMMARY','DETAIL')),
  pricing_mode TEXT NOT NULL DEFAULT 'UNTAXED_UNIT' CHECK (pricing_mode IN ('UNTAXED_UNIT','TAXED_TOTAL')),
  category TEXT NOT NULL,
  item_name TEXT NOT NULL,
  subitem_name TEXT,
  unit TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  untaxed_unit_price_cents INTEGER NOT NULL CHECK (untaxed_unit_price_cents >= 0),
  tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  untaxed_amount_cents INTEGER NOT NULL,
  taxed_amount_cents INTEGER NOT NULL,
  notes TEXT,
  UNIQUE (quote_version_id, section, line_no)
);

CREATE TABLE IF NOT EXISTS quote_document_reviews (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  attachment_version_id TEXT NOT NULL REFERENCES business_attachment_versions(id),
  attachment_sha256 TEXT NOT NULL,
  draft_etag INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  boundary_index INTEGER NOT NULL,
  boundary_location TEXT NOT NULL,
  result_json TEXT NOT NULL,
  reviewed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS quote_document_reviews_version_idx ON quote_document_reviews(quote_version_id, created_at);

CREATE TABLE IF NOT EXISTS quote_approvals (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  stage TEXT NOT NULL CHECK (stage IN ('MANAGER','GENERAL_MANAGER','VP')),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  approver_id TEXT NOT NULL REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (quote_version_id, stage)
);

CREATE TABLE IF NOT EXISTS quote_approval_snapshots (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  approval_id TEXT NOT NULL REFERENCES quote_approvals(id),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (approval_id)
);

CREATE TABLE IF NOT EXISTS contract_templates (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED','VALIDATED','REJECTED','PUBLISHED')),
  validation_json TEXT NOT NULL DEFAULT '{}',
  fixed_fingerprint TEXT,
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TEXT,
  published_by TEXT REFERENCES users(id),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  contract_number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  template_id TEXT NOT NULL REFERENCES contract_templates(id),
  amount_cents INTEGER NOT NULL,
  maintenance_fee_cents INTEGER,
  signed_location TEXT NOT NULL DEFAULT '鹤壁',
  signed_on TEXT,
  party_a_name TEXT,
  license_scope TEXT,
  party_a_legal_representative TEXT,
  party_a_representative TEXT,
  party_a_zip TEXT,
  party_a_address TEXT,
  party_a_phone TEXT,
  confirmations_json TEXT NOT NULL DEFAULT '{}',
  signing_notes TEXT,
  notes_updated_by TEXT REFERENCES users(id),
  notes_updated_at TEXT,
  generation_snapshot_json TEXT,
  generation_snapshot_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','GENERATED','SIGNING','SIGNED','VOID')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  generated_at TEXT,
  updated_at TEXT,
  draft_etag INTEGER NOT NULL DEFAULT 0,
  draft_saved_at TEXT
);

CREATE TABLE IF NOT EXISTS contract_attachment_versions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  final_discount_cents INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, kind, revision)
);

CREATE TABLE IF NOT EXISTS contract_files (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  category TEXT NOT NULL CHECK (category IN ('SYSTEM_GENERATED','WORD_EDITED','FINAL_SIGNED')),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  declared_scope_changed INTEGER NOT NULL DEFAULT 0 CHECK (declared_scope_changed IN (0,1)),
  declaration_json TEXT NOT NULL DEFAULT '{}',
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contract_system_generated_once_idx
ON contract_files(contract_id) WHERE category = 'SYSTEM_GENERATED';

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_logs(entity_type, entity_id, created_at);
