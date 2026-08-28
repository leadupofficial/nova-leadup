# NOVA Production Deployment Guide

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. Prerequisites

- Docker 24+ and Docker Compose v2+
- Node.js 22+ (for local builds)
- pnpm 11.24.0
- Domain `nova.leadup.in` with DNS configured
- SSL certificate (Let's Encrypt / ACM)
- Cloud provider account (AWS/GCP/Azure)
- Secrets manager configured

## 2. Pre-Deployment Checklist

- [ ] All CI security scans passing on main branch
- [ ] Environment variables configured in secrets manager
- [ ] SSL certificate provisioned
- [ ] Database migration scripts tested in staging
- [ ] Backup procedure verified (restore test passed)
- [ ] Monitoring dashboards configured
- [ ] Alerting rules loaded
- [ ] Runbooks reviewed by team
- [ ] DNS records updated
- [ ] Load balancer / reverse proxy configured
- [ ] WAF rules deployed (if applicable)

## 3. Deployment Steps

### 3.1 Build and Push Images
```bash
# Build all service images
docker compose -f docker-compose.prod.yml build

# Tag and push to registry
for service in api auth admin workers; do
 docker tag nova-${service}:latest registry.example.com/nova/${service}:$(git rev-parse --short HEAD)
 docker push registry.example.com/nova/${service}:$(git rev-parse --short HEAD)
done
```

### 3.2 Deploy Infrastructure
```bash
# Provision cloud resources (Terraform / CloudFormation)
terraform apply

# Copy environment configuration
scp .env.production server:/opt/nova/.env

# Deploy
ssh server "cd /opt/nova && docker compose -f docker-compose.prod.yml up -d"

# Verify all services healthy
ssh server "docker compose -f docker-compose.prod.yml ps"
ssh server "curl -s http://localhost:3001/health/ready"
```

### 3.3 Post-Deployment Verification
```bash
# Health checks
curl -s https://nova.leadup.in/health/ready | jq .
curl -s https://nova.leadup.in/health/live | jq .

# Test authentication flow
curl -s -X POST https://nova.leadup.in/auth/health/service -H "Authorization: Bearer $API_KEY" | jq .

# Test database connectivity
curl -s https://nova.leadup.in/admin/health | jq .

# Check metrics endpoint
curl -s https://nova.leadup.in/metrics | head -20
```

### 3.4 Rollback Procedure
```bash
# Rollback to previous image
ssh server "cd /opt/nova && docker compose -f docker-compose.prod.yml up -d --force-recreate api auth admin workers"

# Or redeploy previous git tag
git checkout v0.x.x
# Repeat build and deploy steps
```

## 4. Environment Variables

See `.env.example` for full list. Critical production values:
- `NODE_ENV=production`
- `CORS_ORIGIN=https://nova.leadup.in` (never `*`)
- `JWT_SECRET` — 64+ bytes, cryptographically random
- `POSTGRES_PASSWORD` — strong random password
- All API keys from secrets manager (not plaintext files)

## 5. Security Hardening

- [ ] TLS 1.3 enforced on all endpoints
- [ ] Security headers configured (CSP, HSTS, etc.)
- [ ] CORS restricted to production origins
- [ ] Rate limiting active (Redis-backed in production)
- [ ] Non-root container users
- [ ] Read-only container filesystems
- [ ] Security scanning in CI passes
- [ ] Dependencies audited (no critical/high vulnerabilities)
- [ ] Container images scanned (Trivy)

## 6. Performance Tuning

- PostgreSQL: connection pool sizing, `shared_buffers`, `work_mem`
- Redis: maxmemory policy, persistence config
- Node.js: `--max-old-space-size=512` if needed
- Load balancer: health check intervals, timeout config
