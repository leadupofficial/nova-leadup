# NOVA Production Infrastructure — Terraform Module

## Module: Compute

This module provisions EC2 compute resources for hosting Nova Leadup application services.

### Resources

- EC2 instance (t3.large or configurable)
- Elastic IP (static public IP)
- Security Group (SSH + HTTP + HTTPS)
- IAM Instance Profile with least-privilege permissions
- CloudWatch Agent for system metrics

### Design Decisions

- **t3.large**: 2 vCPU, 8 GB RAM — sufficient for running Docker Compose with all services
- EIP for a stable public IP despite instance restarts
- Security group allows only ports 22, 80, 443 from external
- Instance profile allows access to S3 bucket, CloudWatch Logs, and SSM Session Manager
- SSH access restricted to a configurable CIDR (default: 0.0.0.0/0 — tighten in production)
- CloudWatch agent collects CPU, memory, disk, and network metrics

### Docker Compose Architecture

The EC2 instance runs the full stack via `docker-compose.prod.yml`:
- API (port 3001)
- Auth (port 3003)
- Admin Console (port 3004)
- Workers (background jobs)
- PostgreSQL (containerized)
- Redis (containerized)
- MinIO (containerized)

### Future Scaling

- Auto Scaling Group with 2+ instances behind ALB
- ECS/Fargate for container orchestration
- Separate scaling for workers (SQS-based)
