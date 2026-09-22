# NOVA — Production Server Setup Script
# Run this ONCE on deploy@leadup-server after cloning the repo
# Usage: bash scripts/setup-server.sh

set -euo pipefail

echo "=== NOVA Server Setup ==="
echo "Domain: nova.leadup.in"
echo "Server: deploy@leadup-server"

# ─── System packages ─────────────────────────────────────────────
echo "[1/6] Installing system packages..."
sudo apt update
sudo apt install -y \
 curl \
 git \
 nginx \
 certbot \
 python3-certbot-nginx \
 postgresql \
 postgresql-contrib \
 redis-server

# ─── Docker ──────────────────────────────────────────────────────
echo "[2/6] Setting up Docker..."
if ! command -v docker &>/dev/null; then
 curl -fsSL https://get.docker.com | sh
 sudo systemctl enable --now docker
 sudo usermod -aG docker deploy
fi

# ─── Node.js & pnpm ──────────────────────────────────────────────
echo "[3/6] Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
 curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
 sudo apt install -y nodejs
fi
corepack enable && corepack prepare pnpm@latest --activate

# ─── PostgreSQL ──────────────────────────────────────────────────
echo "[4/6] Configuring PostgreSQL..."
sudo -u postgres psql -c "CREATE DATABASE nova;" 2>/dev/null || echo "Database exists"
sudo -u postgres psql -c "CREATE USER nova_user WITH ENCRYPTED PASSWORD '${POSTGRES_PASSWORD:-change-me-in-production}';" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nova TO nova_user;" 2>/dev/null || true
sudo -u postgres psql -d nova -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
echo "pg_hba.conf needs: local nova_user nova_user scram-sha-256"
echo "Edit with: sudo nano /etc/postgresql/*/main/pg_hba.conf"

# ─── Redis ───────────────────────────────────────────────────────
echo "[5/6] Configuring Redis..."
sudo systemctl enable --now redis-server
sudo redis-cli CONFIG SET requirepass "${REDIS_PASSWORD:-change-me-in-production}" 2>/dev/null || true

# ─── SSL Certificate ─────────────────────────────────────────────
echo "[6/6] SSL Certificate..."
echo "Run this after DNS is pointed to this server:"
echo " sudo certbot --nginx -d nova.leadup.in"

echo ""
echo "=== Setup Complete ==="
echo "Next steps:"
echo " 1. Point nova.leadup.in DNS A record to this server's IP"
echo " 2. Clone repo to /opt/nova"
echo " 3. Copy .env.example to .env and fill in secrets"
echo " 4. Run: pnpm install && pnpm build:packages"
echo " 5. Run migrations: cd services/api && pnpm db:migrate"
echo " 6. Start services: docker compose up -d --build"
echo " 7. Configure nginx: sudo cp deploy/nginx/nova.conf /etc/nginx/sites-available/"
echo " 8. Get SSL: sudo certbot --nginx -d nova.leadup.in"
