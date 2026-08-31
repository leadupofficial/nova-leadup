-- ============================================================
-- LEA-57: Admin Console, Audit, and Observability — Schema
-- ============================================================

-- ------------------------------------------------------------
-- 1. Audit log enrichment (immutable events per action)
-- Add actor context, request ID, device info, decisions
-- ------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id VARCHAR(64);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_session_id UUID REFERENCES sessions(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_device_id UUID REFERENCES devices(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tool_name VARCHAR(100);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tool_input JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tool_output JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS decision VARCHAR(20) DEFAULT 'allowed' CHECK (decision IN ('allowed', 'denied', 'escalated'));
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(64);

-- Audit log is append-only — prevent UPDATE/DELETE
DO $$
BEGIN
 IF NOT EXISTS (
 SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_log' AND policyname = 'audit_log_no_modify'
 ) THEN
 CREATE POLICY audit_log_no_modify ON audit_log
 FOR ALL USING (false);
 END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_log_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation_id ON audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON audit_log(tool_name);

-- ------------------------------------------------------------
-- 2. Feature Flags
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 key VARCHAR(100) NOT NULL UNIQUE,
 description TEXT,
 enabled BOOLEAN NOT NULL DEFAULT false,
 rollout_percentage INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
 allowed_org_ids UUID[] DEFAULT '{}',
 allowed_user_ids UUID[] DEFAULT '{}',
 metadata JSONB DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_key ON feature_flags(key);

-- ------------------------------------------------------------
-- 3. Incident Events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_events (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
 severity VARCHAR(20) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
 category VARCHAR(50) NOT NULL,
 title VARCHAR(255) NOT NULL,
 description TEXT,
 source VARCHAR(100),
 metadata JSONB DEFAULT '{}',
 acknowledged_at TIMESTAMPTZ,
 acknowledged_by UUID REFERENCES users(id),
 resolved_at TIMESTAMPTZ,
 resolved_by UUID REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_events_org ON incident_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_incident_events_severity ON incident_events(severity);
CREATE INDEX IF NOT EXISTS idx_incident_events_category ON incident_events(category);
CREATE INDEX IF NOT EXISTS idx_incident_events_created ON incident_events(created_at);

-- ------------------------------------------------------------
-- 4. Cost / Usage Metering
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_usage_records (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id UUID REFERENCES users(id) ON DELETE SET NULL,
 session_id UUID,
 metric VARCHAR(50) NOT NULL,
 unit VARCHAR(20) NOT NULL,
 quantity DECIMAL(18,6) NOT NULL,
 cost_cents INTEGER NOT NULL DEFAULT 0,
 provider VARCHAR(50),
 model VARCHAR(100),
 metadata JSONB DEFAULT '{}',
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_usage_org ON cost_usage_records(organization_id);
CREATE INDEX IF NOT EXISTS idx_cost_usage_workspace ON cost_usage_records(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cost_usage_metric ON cost_usage_records(metric, recorded_at);
CREATE INDEX IF NOT EXISTS idx_cost_usage_session ON cost_usage_records(session_id);

-- ------------------------------------------------------------
-- 5. Metrics Snapshots (for dashboard aggregation)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics_snapshots (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 metric_name VARCHAR(100) NOT NULL,
 value NUMERIC NOT NULL,
 dimensions JSONB DEFAULT '{}',
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_org_metric ON metrics_snapshots(organization_id, metric_name, recorded_at);
