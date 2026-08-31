-- ============================================================
-- LEA-57: System Health Checks and Admin Policy Rules
-- ============================================================

-- ------------------------------------------------------------
-- 1. System Health Checks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_health_checks (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 check_name VARCHAR(100) NOT NULL UNIQUE,
 category VARCHAR(50) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
 latency_ms INTEGER,
 message TEXT,
 metadata JSONB DEFAULT '{}',
 checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_health_checks_status ON system_health_checks(status);
CREATE INDEX IF NOT EXISTS idx_system_health_checks_category ON system_health_checks(category);

-- Seed default health checks
INSERT INTO system_health_checks (check_name, category, status) VALUES
 ('database', 'infrastructure', 'healthy'),
 ('redis', 'infrastructure', 'healthy'),
 ('storage', 'infrastructure', 'healthy'),
 ('api_gateway', 'services', 'healthy'),
 ('auth_service', 'services', 'healthy'),
 ('worker_pool', 'services', 'healthy'),
 ('stt_provider', 'ai_providers', 'healthy'),
 ('tts_provider', 'ai_providers', 'healthy'),
 ('llm_provider', 'ai_providers', 'healthy')
ON CONFLICT (check_name) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Admin Policy Rules (V1 placeholder, extensible for V2)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_policy_rules (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
 name VARCHAR(255) NOT NULL,
 description TEXT,
 rule_type VARCHAR(50) NOT NULL DEFAULT 'custom',
 priority INTEGER NOT NULL DEFAULT 0,
 condition JSONB NOT NULL DEFAULT '{}',
 action JSONB NOT NULL DEFAULT '{}',
 enabled BOOLEAN NOT NULL DEFAULT true,
 created_by UUID REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_policy_rules_org ON admin_policy_rules(organization_id);
CREATE INDEX IF NOT EXISTS idx_admin_policy_rules_enabled ON admin_policy_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_admin_policy_rules_type ON admin_policy_rules(rule_type);
