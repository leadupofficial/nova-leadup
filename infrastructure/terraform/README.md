# NOVA Production Infrastructure

## Prerequisites

- Terraform >= 1.6.0
- AWS CLI configured with credentials
- SSH key pair created in AWS for EC2 access
- ACM certificate for `nova.leadup.in` (can be created via Terraform)

## Quick Start

```bash
# Initialize Terraform
terraform init

# Plan the deployment
terraform plan -var-file="production.tfvars"

# Apply the infrastructure
terraform apply -var-file="production.tfvars"
```

## Configuration

See `production.tfvars.example` for all available variables.

## Modules

| Module | Purpose |
|--------|---------|
| `modules/networking` | VPC, subnets, NAT gateway, route tables, flow logs |
| `modules/compute` | EC2 instance, security groups, IAM, Elastic IP |
| `modules/database` | RDS PostgreSQL + pgvector, ElastiCache Redis |
| `modules/storage` | S3 bucket for assets, Terraform state backend |
| `modules/loadbalancer` | ALB for HTTPS termination (optional) |

## Post-Provisioning

After `terraform apply`, run the deployment script:

```bash
cd infrastructure/deployment
./deploy.sh <ec2-public-ip>
```

## State Management

Terraform state is stored in S3 with DynamoDB locking. State file:
`s3://nova-leadup-terraform-state-production/terraform.tfstate`

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| EC2 t3.large | ~$30-35 |
| RDS db.t3.small | ~$15-25 |
| ElastiCache cache.t3.micro | ~$12-15 |
| ALB | ~$16-20 |
| S3 Storage | ~$1-10 |
| Data Transfer | ~$5-15 |
| **Total** | **~$80-120/month** |
