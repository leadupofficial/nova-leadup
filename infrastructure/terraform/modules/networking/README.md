# NOVA Production Infrastructure — Terraform Module

## Module: Networking

This module provisions the full networking layer for Nova Leadup production infrastructure.

### Resources

- VPC (10.0.0.0/16)
- 2 Public subnets (10.0.1.0/24, 10.0.2.0/24) across 2 AZs
- 2 Private subnets (10.0.10.0/24, 10.0.20.0/24) across 2 AZs
- Internet Gateway
- NAT Gateway (1 per AZ for high availability)
- Route tables (public + private per AZ)
- VPC Flow Logs to CloudWatch Logs
- Optional: Transit Gateway peering for multi-VPC

### Design Decisions

- Multi-AZ subnets for RDS and application resilience
- NAT Gateway for private subnet outbound (security updates, API calls)
- VPC Flow Logs for network traffic auditing and security analysis
- /16 VPC allows up to 256 subnets for future growth

### Security

- No public IPs on RDS or Redis instances
- Security groups follow least-privilege (only required ports open)
- No SSH from the internet (bastion host via Session Manager recommended)
- Flow logs retained in CloudWatch for 30 days

### References

- AWS VPC Best Practices: https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-best-practices.html
