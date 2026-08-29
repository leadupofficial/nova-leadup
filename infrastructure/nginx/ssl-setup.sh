#!/bin/bash
# NOVA SSL Certificate Setup with Certbot
# Provisions and auto-renews Let's Encrypt certificates for nova.leadup.in

set -euo pipefail

DOMAIN="nova.leadup.in"
EMAIL="devops@leadup.in"
WEBROOT="/var/www/letsencrypt"

echo "[ssl] Setting up SSL certificate for ${DOMAIN}..."

# Install certbot if not present
if ! command -v certbot &>/dev/null; then
 echo "[ssl] Installing certbot..."
 dnf install -y certbot python3-certbot-nginx || \
 yum install -y certbot python2-certbot-nginx || \
 snap install certbot --classic
fi

# Create webroot directory
mkdir -p "${WEBROOT}/.well-known/acme-challenge"
chown -R nginx:nginx "${WEBROOT}"

# Obtain certificate using webroot plugin
echo "[ssl] Obtaining certificate for ${DOMAIN}..."
certbot certonly --webroot \
 -w "${WEBROOT}" \
 -d "${DOMAIN}" \
 -d "admin.${DOMAIN}" \
 --email "${EMAIL}" \
 --agree-tos \
 --no-eff-email \
 --non-interactive

echo "[ssl] Certificate obtained successfully."
echo "[ssl] Certificate path: /etc/letsencrypt/live/${DOMAIN}/"
echo ""
echo "[ssl] Setting up auto-renewal..."

# Create renewal hook to reload nginx after renewal
mkdir -p /etc/letsencrypt/renewal-hooks/post
cat > /etc/letsencrypt/renewal-hooks/post/nginx-reload.sh << 'SCRIPT'
#!/bin/bash
nginx -t && systemctl reload nginx
SCRIPT
chmod +x /etc/letsencrypt/renewal-hooks/post/nginx-reload.sh

# Test renewal
echo "[ssl] Testing renewal process..."
certbot renew --dry-run

echo "[ssl] SSL setup complete. Certificates will auto-renew."
