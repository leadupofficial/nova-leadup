# NOVA Production Infrastructure — Terraform Module

## Module: Load Balancer

This module provisions an Application Load Balancer (ALB) for HTTPS termination and traffic routing.

### Resources

- Application Load Balancer (internet-facing)
- HTTPS listener with ACM certificate
- HTTP → HTTPS redirect listener
- Target group for the application server
- ALB security group (allow 80/443 from internet)
- ALB access logs to S3

### Design Decisions

- ALB terminates TLS at the load balancer, passes traffic via HTTP to EC2 instance
- HTTP port 80 automatically redirects to HTTPS
- Health check on `/health/live` endpoint
- Cross-zone load balancing enabled
- Access logs retained for security auditing and troubleshooting

### Security

- TLS 1.3 enforced via ALB policy
- Security headers via nginx (CORS, CSP, HSTS)
- WAF rules can be attached to ALB (optional)
