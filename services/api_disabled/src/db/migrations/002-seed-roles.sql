-- Seed system-defined roles
INSERT INTO roles (id, key, display_name, description, is_system)
VALUES
 (uuid_generate_v4(), 'owner', 'Owner', 'Full organization access including billing and deletion', true),
 (uuid_generate_v4(), 'admin', 'Admin', 'Organization-wide admin excluding billing deletion', true),
 (uuid_generate_v4(), 'manager', 'Manager', 'Can manage workspaces, invite users, and view data', true),
 (uuid_generate_v4(), 'member', 'Member', 'Standard workspace member with view/use access', true),
 (uuid_generate_v4(), 'auditor', 'Auditor', 'Read-only access to audit trails and workspace data', true),
 (uuid_generate_v4(), 'support_limited', 'Support Limited', 'Minimal read-only access for customer support', true)
ON CONFLICT (key) DO NOTHING;
