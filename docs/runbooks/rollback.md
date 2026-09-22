# NOVA Leadup — Rollback Runbook
# Procedures for rolling back deployments when issues are detected.

## Table of Contents
1. [When to Rollback](#when-to-rollback)
2. [Decision Tree](#decision-tree)
3. [Rollback Procedures](#rollback-procedures)
4. [Verification](#verification)
5. [Post-Rollback](#post-rollback)

---

## When to Rollback

### Automatic Triggers
- Error rate exceeds 5% for 5+ minutes
- p95 latency exceeds 2s for 5+ minutes
- Health checks failing for 3+ consecutive attempts
- Database connection failures

### Manual Triggers
- Critical bug discovered in production
- Security vulnerability in deployed code
- Data corruption detected
- Third-party service outage affecting functionality

---

## Decision Tree

```
Issue Detected
 │
 ├─ Can be fixed with config change? → Update ConfigMap/Secret, no rollback
 │
 ├─ Affects single pod? → Restart pod
 │
 ├─ Affects all pods? → Rollback deployment
 │
 ├─ Affects infrastructure? → Terraform rollback
 │
 └─ Data issue? → Restore from backup (see disaster-recovery.md)
```

---

## Rollback Procedures

### 1. Kubernetes Deployment Rollback

#### Rollback API Service

```bash
# Check rollout history
kubectl rollout history deployment/nova-api -n nova

# Rollback to previous version
kubectl rollout undo deployment/nova-api -n nova

# Rollback to specific revision
kubectl rollout undo deployment/nova-api -n nova --to-revision=3

# Verify rollback
kubectl rollout status deployment/nova-api -n nova
kubectl get pods -n nova -l app=nova-api
```

#### Rollback Realtime Gateway

```bash
kubectl rollout history deployment/nova-realtime -n nova
kubectl rollout undo deployment/nova-realtime -n nova
kubectl rollout status deployment/nova-realtime -n nova
```

#### Rollback All Services

```bash
# Rollback all NOVA deployments
for deployment in $(kubectl get deployments -n nova -o name); do
 echo "Rolling back $deployment..."
 kubectl rollout undo $deployment -n nova
done

# Verify all rollbacks
kubectl get deployments -n nova
kubectl get pods -n nova
```

### 2. Container Image Rollback

If the previous image version is known:

```bash
# Patch deployment with previous image
kubectl set image deployment/nova-api \
 api=ghcr.io/leadup-technologies/nova-api:v1.2.3 \
 -n nova

# Or edit deployment directly
kubectl edit deployment/nova-api -n nova
# Change image tag under spec.template.spec.containers[0].image

# Verify
kubectl rollout status deployment/nova-api -n nova
```

### 3. Database Migration Rollback

#### Rollback Migrations

```bash
# Check migration status
cd services/api
pnpm run db:migrate:status

# Rollback last migration
pnpm run db:migrate:down

# Rollback multiple migrations
pnpm run db:migrate:down --all
```

#### Database Backup Restore

If migration rollback is not possible:

```bash
# List available backups
aws s3 ls s3://nova-terraform-state/backups/

# Restore from backup
# (See disaster-recovery.md for full procedure)
```

### 4. Configuration Rollback

#### ConfigMap Rollback

```bash
# Get previous ConfigMap version
kubectl get configmap nova-config -n nova -o yaml > config-backup.yaml

# Restore from backup
kubectl apply -f config-backup.yaml

# Or edit directly
kubectl edit configmap nova-config -n nova

# Restart pods to pick up changes
kubectl rollout restart deployment/nova-api -n nova
kubectl rollout restart deployment/nova-realtime -n nova
```

#### Secret Rollback

```bash
# Secrets are immutable — create new secret with previous values
kubectl create secret generic nova-secrets --from-literal=... -n nova --dry-run=client -o yaml | kubectl apply -f -

# Update deployments to use new secret
kubectl rollout restart deployment/nova-api -n nova
```

### 5. Terraform Rollback

#### Rollback Infrastructure Changes

```bash
cd infrastructure/terraform

# Check state
terraform state list

# Import previous state if needed
terraform state pull > previous-state.json

# Revert .tf files to previous versions
git checkout HEAD~1 -- infrastructure/

# Plan and apply
terraform plan
terraform apply
```

#### Rollback Specific Resources

```bash
# Import resource from previous state
terraform import aws_db_instance.nova_postgres <db-instance-id>

# Or destroy and recreate
terraform destroy -target=aws_db_instance.nova_postgres
terraform apply
```

---

## Verification

### After Rollback

```bash
# 1. Verify pods are running
kubectl get pods -n nova

# 2. Verify health endpoints
kubectl port-forward service/nova-api 3000:3000 -n nova
curl http://localhost:3000/health

# 3. Verify database connectivity
kubectl exec -n nova -it deployment/nova-api -- \
 node -e "const { Pool} = require('pg'); new Pool({connectionString: process.env.DATABASE_URL}).query('SELECT 1')"

# 4. Verify Redis connectivity
kubectl exec -n nova -it deployment/nova-api -- \
 node -e "const Redis = require('ioredis'); const r = new Redis(process.env.REDIS_URL); r.ping()"

# 5. Check logs for errors
kubectl logs -n nova deployment/nova-api --tail=100
kubectl logs -n nova deployment/nova-realtime --tail=100

# 6. Verify metrics
curl http://localhost:9090/metrics | head -20
```

### Success Criteria

- [ ] All pods are Running (not CrashLoopBackOff)
- [ ] Health checks return 200 OK
- [ ] No error spikes in logs
- [ ] Database connections successful
- [ ] Redis connections successful
- [ ] Error rate back to normal (<1%)
- [ ] p95 latency back to normal (<500ms)

---

## Post-Rollback

### 1. Document the Incident

```bash
# Record rollback details
cat > /tmp/rollback-$(date +%Y%m%d-%H%M%S).md << EOF
# Rollback Report

**Date:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")
**Triggered by:** [person/alert]
**Issue:** [description]
**Rollback version:** [commit/tag/revision]
**Duration:** [time from detection to resolution]

## Timeline
- [HH:MM] Issue detected
- [HH:MM] Decision to rollback made
- [HH:MM] Rollback executed
- [HH:MM] Verification complete

## Root Cause
[What caused the issue]

## Action Items
- [ ] [Preventive measure 1]
- [ ] [Preventive measure 2]
EOF
```

### 2. Notify Team

- Post summary to #incidents Slack channel
- Update status page if customer-facing
- Schedule post-mortem if severity > medium

### 3. Prevent Recurrence

- Add tests for the bug
- Add monitoring for the failure mode
- Update deployment checklist
- Consider feature flags for risky changes

---

## Emergency Contacts

| Role | Contact |
|------|---------|
| On-call Engineer | [Slack @oncall] |
| DevOps Lead | [Slack @devops] |
| Engineering Lead | [Slack @eng-lead] |
| AWS Support | [Support case] |

---

## Related Documents

- [deploy.md](./deploy.md) — Deployment procedures
- [disaster-recovery.md](../operations/disaster-recovery.md) — Full disaster recovery
- [incident-response.md](../operations/incident-response.md) — Incident management
- [monitoring.md](../operations/monitoring.md) — Monitoring setup
