-- ============================================================
-- LEA-44: Authentication & Tenant Model — Initial Schema
-- ============================================================

-- ------------------------------------------------------------
-- 1. Organizations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 name VARCHAR(255) NOT NULL,
 slug VARCHAR(100) NOT NULL UNIQUE,
 plan VARCHAR(20) NOT NULL DEFAULT 'free',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_deleted ON organizations(deleted_at);

-- ------------------------------------------------------------
-- 2. Workspaces
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 name VARCHAR(255) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ,
 UNIQUE(organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_deleted ON workspaces(deleted_at);

-- ------------------------------------------------------------
-- 3. Users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 email CITEXT NOT NULL UNIQUE,
 phone_number VARCHAR(20),
 email_verified BOOLEAN NOT NULL DEFAULT false,
 phone_verified BOOLEAN NOT NULL DEFAULT false,
 password_hash TEXT,
 primary_organization_id UUID REFERENCES organizations(id),
 primary_workspace_id UUID REFERENCES workspaces(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ,
 CONSTRAINT email_or_phone CHECK (email IS NOT NULL OR phone_number IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at);
CREATE INDEX IF NOT EXISTS idx_users_primary_org ON users(primary_organization_id);

-- ------------------------------------------------------------
-- 4. User Profiles (display name, avatar, timezone, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 display_name VARCHAR(255),
 avatar_url TEXT,
 timezone VARCHAR(50) DEFAULT 'UTC',
 locale VARCHAR(10) DEFAULT 'en-US',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ,
 UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id);

-- ------------------------------------------------------------
-- 5. Roles (system-defined, seeded)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 key VARCHAR(50) NOT NULL UNIQUE,
 display_name VARCHAR(100) NOT NULL,
 description TEXT,
 is_system BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 6. Role Bindings (user ↔ workspace role)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_bindings (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 role_id UUID NOT NULL REFERENCES roles(id),
 granted_by UUID NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ,
 UNIQUE(user_id, workspace_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_role_bindings_user ON role_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_role_bindings_workspace ON role_bindings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_role_bindings_role ON role_bindings(role_id);

-- ------------------------------------------------------------
-- 7. Sessions (access + refresh tokens)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL,
 refresh_token_hash TEXT,
 status VARCHAR(20) NOT NULL DEFAULT 'active',
 mfa_verified BOOLEAN NOT NULL DEFAULT false,
 user_agent TEXT,
 ip_address INET,
 last_used_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------
-- 8. Devices (for trusted-device tracking)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name VARCHAR(255),
 fingerprint TEXT NOT NULL,
 user_agent TEXT,
 is_trusted BOOLEAN NOT NULL DEFAULT false,
 last_seen_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- ------------------------------------------------------------
-- 9. Phone OTP Codes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_otp_codes (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 phone_number VARCHAR(20) NOT NULL,
 code_hash TEXT NOT NULL,
 channel VARCHAR(20) NOT NULL,
 purpose VARCHAR(20) NOT NULL,
 consumed BOOLEAN NOT NULL DEFAULT false,
 consumed_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,
 attempts SMALLINT NOT NULL DEFAULT 0,
 max_attempts SMALLINT NOT NULL DEFAULT 5,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_expires ON phone_otp_codes(phone_number, expires_at);

-- ------------------------------------------------------------
-- 10. Password Reset Tokens
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL,
 consumed BOOLEAN NOT NULL DEFAULT false,
 consumed_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token_hash);

-- ------------------------------------------------------------
-- 11. API Keys (service-to-service auth)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 created_by UUID NOT NULL REFERENCES users(id),
 name VARCHAR(100) NOT NULL,
 key_prefix TEXT NOT NULL,
 key_hash TEXT NOT NULL,
 scopes TEXT[] NOT NULL DEFAULT '{}',
 expires_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ------------------------------------------------------------
-- 12. Audit log (system events)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 actor_user_id UUID REFERENCES users(id),
 action VARCHAR(100) NOT NULL,
 resource_type VARCHAR(50),
 resource_id UUID,
 changes JSONB,
 ip_address INET,
 user_agent TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
