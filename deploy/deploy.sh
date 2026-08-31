#!/bin/bash
# NOVA Production Deployment Script
# Run this on your server: ssh deploy@leadup-server 'bash -s' < deploy.sh
# Or copy to server and run: sudo bash deploy.sh

set -e

echo "🚀 Deploying NOVA to nova.leadup.in..."

# Variables
DOMAIN="nova.leadup.in"
EMAIL="contact@leadup.in" # Change this to your email for Let's Encrypt
WEB_DIR="$HOME/nova/web"
API_DIR="$HOME/nova/api"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📦 Step 1/8: Installing nginx and certbot...${NC}"
if ! command -v nginx &> /dev/null; then
 echo "Installing nginx..."
 apt-get update -qq
 apt-get install -y nginx certbot python3-certbot-nginx
else
 echo "nginx already installed"
fi

echo -e "${BLUE}🔧 Step 2/8: Creating nginx configuration...${NC}"
sudo tee /etc/nginx/sites-available/nova.leadup.in > /dev/null <<'EOF'
server {
 listen 80;
 server_name nova.leadup.in;

 location / {
 proxy_pass http://127.0.0.1:8080;
 proxy_http_version 1.1;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection 'upgrade';
 proxy_set_header Host $host;
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 proxy_set_header X-Forwarded-Proto $scheme;
 proxy_cache_bypass $http_upgrade;
 }

 location /api/ {
 proxy_pass http://127.0.0.1:3000;
 proxy_http_version 1.1;
 proxy_set_header Host $host;
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 proxy_set_header X-Forwarded-Proto $scheme;
 }
}
EOF

echo -e "${BLUE}🔗 Step 3/8: Enabling site...${NC}"
sudo ln -sf /etc/nginx/sites-available/nova.leadup.in /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo -e "${BLUE}🔒 Step 4/8: Setting up SSL with Let's Encrypt...${NC}"
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect

echo -e "${BLUE}🐳 Step 5/8: Building Docker images...${NC}"
cd $HOME/nova
docker build -t nova-web:latest -f deploy/web/Dockerfile .
docker build -t nova-api:latest -f deploy/api/Dockerfile services/api/

echo -e "${BLUE}🚀 Step 6/8: Starting services...${NC}"
# Create network if not exists
docker network create nova-network 2>/dev/null || true

# Stop existing containers
docker rm -f nova-web nova-api 2>/dev/null || true

# Start web container
docker run -d \
 --name nova-web \
 --network nova-network \
 -p 8080:80 \
 -v $WEB_DIR/downloads:/usr/share/nginx/html/downloads \
 nova-web:latest

# Start API container
docker run -d \
 --name nova-api \
 --network nova-network \
 -p 3000:3000 \
 -e DATABASE_URL=${DATABASE_URL} \
 -e REDIS_URL=${REDIS_URL} \
 -e JWT_SECRET=${JWT_SECRET} \
 -e ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY} \
 -e SARVAM_API_KEY=${SARVAM_API_KEY} \
 -e ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY} \
 -e S3_ENDPOINT=${S3_ENDPOINT} \
 -e S3_ACCESS_KEY=${S3_ACCESS_KEY} \
 -e S3_SECRET_KEY=${S3_SECRET_KEY} \
 -e S3_BUCKET=${S3_BUCKET} \
 -e CORS_ORIGIN=${CORS_ORIGIN:-https://nova.leadup.in} \
 -e NODE_ENV=production \
 --env-file .env.production \
 nova-api:latest

echo -e "${BLUE}⏳ Step 7/8: Waiting for services...${NC}"
sleep 10

echo -e "${BLUE}🔍 Step 8/8: Health checks...${NC}"
curl -f http://127.0.0.1:8080/health || echo "Web health check failed"
curl -f http://127.0.0.1:3000/health || echo "API health check failed"

echo -e "${GREEN}✅ Deployment complete!${NC}"
echo -e "${GREEN}🌐 Landing page: https://$DOMAIN${NC}"
echo -e "${GREEN}📱 API: https://$DOMAIN/api${NC}"
echo -e "${GREEN}🔗 Download APK: https://$DOMAIN/download/nova.apk${NC}"
