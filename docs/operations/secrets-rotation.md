# Secrets Rotation Procedures — NOVA Platform

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. Secrets Inventory

| Secret | Where Used | Rotation Frequency | Last Rotated |
|--------|-----------|-------------------|--------------|
| `JWT_SECRET` | API service, auth service, admin | 90 days | — |
| `REFRESH_TOKEN_SECRET` | Auth service | 90 days | — |
| `AUTH_ENCRYPTION_KEY` | Auth service | 90 days | — |
| `API_KEY_SECRET` | Auth service | 90 days | — |
| `POSTGRES_PASSWORD` | PostgreSQL | 90 days | — |
| `REDIS_PASSWORD` | All services | 90 days | — |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | API, workers | 90 days | — |
| `OPENAI_API_KEY` | External (workers) | Per provider policy | — |
| `ANTHROPIC_API_KEY` | External (workers) | Per provider policy | — |
| `ELEVENLABS_API_KEY` | External (workers) | Per provider policy | — |
| `WHISPER_API_KEY` | External (workers) | Per provider policy | — |

---

## 2. Rotation Procedure

### 2.1 Standard Rotation (No Downtime)

```bash
#!/bin/bash
# scripts/rotate-secret.sh <secret-name>
set -euo pipefail

SECRET_NAME="${1:?Secret name required}"

case "$SECRET_NAME" in
 jwt_secret)
 # 1. Generate new secret
 NEW_SECRET=$(openssl rand -base64 64)
 # 2. Update environment variable in production
 # 3. Rolling restart of services (old tokens still valid until expiry)
 docker compose -f docker-compose.prod.yml restart auth api admin
 # 4. Old JWTs expire within 15 minutes (JWT_EXPIRES_IN)
 ;;
 postgres_password)
 # 1. Generate new password
 NEW_PASS=$(openssl rand -base64 32)
 # 2. Update PostgreSQL user password
 docker compose -f docker-compose.prod.yml exec postgres \
 psql -U postgres -c "ALTER USER ${POSTGRES_USER} WITH PASSWORD '${NEW_PASS}';"
 # 3. Update environment variables and restart dependent services
 # Requires brief downtime window
 docker compose -f docker-compose.prod.yml restart api auth admin workers
 ;;
 redis_password)
 # 1. Generate new password
 NEW_PASS=$(openssl rand -base64 32)
 # 2. Update Redis config and restart
 docker compose -f docker-compose.prod.yml exec redis \
 redis-cli CONFIG SET requirepass "${NEW_PASS}"
 # 3. Update environment variables and restart dependent services
 docker compose -f docker-compose.prod.yml restart api auth admin workers
 ;;
esac

echo "Rotation complete for ${SECRET_NAME}"
```

### 2.2 Emergency Rotation (Credential Compromised)

1. **Immediately revoke** the compromised secret
2. Generate new secret using the procedure above
3. For JWTs: invalidate all active sessions in Redis
4. Review audit logs for unauthorized access during exposure window
5. Notify security team
6. Follow incident response runbook

### 2.3 Rolling Secret Rotation Pattern

For zero-downtime JWT rotation:
```
1. Generate new JWT_SECRET → set as JWT_SECRET_NEW
2. Services verify against BOTH JWT_SECRET and JWT_SECRET_NEW
3. After 15 minutes (JWT expiry), old tokens are all invalidated
4. Remove JWT_SECRET, rename JWT_SECRET_NEW → JWT_SECRET
5. Restart services
```

---

## 3. Best Practices

- Store secrets in a secrets manager (AWS Secrets Manager, HashiCorp Vault) in production
- Never commit secrets to version control
- Use `.env` files only for local development
- Enable automatic rotation where supported by cloud provider
- Maintain an audit trail of all secret changes
- Rotate immediately when team member leaves
- Use different secrets per environment (dev/staging/prod)

---

## 4. Pre-Deployment Checklist

- [ ] All secrets configured in environment
- [ ] No hardcoded secrets in codebase (grep for patterns)
- [ ] `.env` files are in `.gitignore`
- [ ] Secret rotation schedule is active
- [ ] Secrets manager integration configured (production)
