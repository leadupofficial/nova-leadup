# NOVA Deployment Guide

## Server Information
- **Domain:** nova.leadup.in
- **SSH:** deploy@leadup-server
- **Stack:** Node.js + PostgreSQL + Redis + Docker

## Prerequisites on Server
```bash
# Install Docker & Docker Compose
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
corepack enable && corepack prepare pnpm@latest --activate

# Install Nginx
sudo apt install -y nginx
```

## Environment Setup
```bash
# On the server, create the environment file
sudo mkdir -p /opt/nova
sudo chown deploy:deploy /opt/nova
cd /opt/nova
git clone <your-repo-url> .
cp .env.example .env
# Edit .env with production values
nano .env
```

## Database Setup
```bash
# Create PostgreSQL database
sudo -u postgres psql -c "CREATE DATABASE nova;"
sudo -u postgres psql -c "CREATE USER nova_user WITH ENCRYPTED PASSWORD 'strong-password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nova TO nova_user;"
sudo -u postgres psql -d nova -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## Build & Deploy
```bash
# Pull latest code
git pull origin main

# Install dependencies
pnpm install

# Build packages
pnpm build:packages

# Run database migrations
cd services/api && pnpm db:migrate

# Start with Docker Compose
cd /opt/nova
docker compose up -d --build
```

## Nginx Configuration
Create `/etc/nginx/sites-available/nova.leadup.in`:
```nginx
server {
 listen 80;
 server_name nova.leadup.in;
 return 301 https://$server_name$request_uri;
}

server {
 listen 443 ssl http2;
 server_name nova.leadup.in;

 ssl_certificate /etc/letsencrypt/live/nova.leadup.in/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/nova.leadup.in/privkey.pem;

 # API
 location /api/ {
 proxy_pass http://127.0.0.1:3001/api/;
 proxy_http_version 1.1;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection 'upgrade';
 proxy_set_header Host $host;
 proxy_cache_bypass $http_upgrade;
 client_max_body_size 50M;
 }

 # WebSocket for real-time
 location /socket.io/ {
 proxy_pass http://127.0.0.1:3001/socket.io/;
 proxy_http_version 1.1;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection "Upgrade";
 proxy_set_header Host $host;
 }

 # Web (if served from same domain)
 location / {
 proxy_pass http://127.0.0.1:3000;
 proxy_http_version 1.1;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection 'upgrade';
 proxy_set_header Host $host;
 proxy_cache_bypass $http_upgrade;
 }
}
```

Enable the site:
```bash
sudo ln -sf /etc/nginx/sites-available/nova.leadup.in /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## SSL Certificate
```bash
sudo certbot --nginx -d nova.leadup.in -d admin.nova.leadup.in
```

## Health Check
```bash
curl https://nova.leadup.in/health
# Expected: {"status":"ok","timestamp":"..."}
```

## EAS Build (Mobile)
```bash
# Install EAS CLI
pnpm add -g eas-cli

# Configure (run once)
eas login
eas build:configure

# Production build
eas build --platform android --profile production

# Submit to Play Store
eas submit --platform android --profile production
```

## Monitoring
- Health endpoint: GET https://nova.leadup.in/health
- Logs: `docker compose logs -f api`
- PostgreSQL: `docker compose exec postgres psql -U nova -d nova`
