# NOVA Production Infrastructure — Terraform Module

## Module: Database

This module provisions managed database and cache services on AWS.

### Resources

- RDS PostgreSQL 16 (db.t3.small, Multi-AZ enabled)
- RDS Parameter Group (PostgreSQL 16 with pgvector-friendly settings)
- RDS Subnet Group (private subnets)
- DB Security Group (port 5432 only from app server + nginx)
- ElastiCache Redis 7 (cache.t3.micro, cluster mode disabled)
- ElastiCache Subnet Group
- Redis Security Group (port 6379 only from app server)
- Automated backups: 7-day retention, daily at 02:00 UTC

### Design Decisions

- **RDS over self-hosted PostgreSQL**: automated backups, Multi-AZ failover, patching
- **db.t3.small**: 2 vCPU, 4 GB — burstable, cost-effective for production baseline
- **Multi-AZ**: automatic failover in case of AZ outage (~60-120s RTO)
- **ElastiCache Redis**: managed Redis with AOF persistence and automatic failover
- **pgvector**: RDS PostgreSQL 16 supports pgvector extension; enable via parameter group or init script
- **Encryption at rest**: RDS and ElastiCache storage encrypted with KMS

### Backup Strategy

- Automated RDS snapshots: daily, 7-day retention
- Point-in-time recovery: enabled (5-minute granularity)
- Cross-region snapshot copy: recommended for disaster recovery

### Cost Estimate

- RDS db.t3.small: ~$15-25/month
- ElastiCache cache.t3.micro: ~$12-15/month
- Storage + I/O: ~$5-10/month
- **Total database layer: ~$35-55/month**
