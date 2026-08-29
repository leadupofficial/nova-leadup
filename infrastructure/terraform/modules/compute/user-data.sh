#!/bin/bash
# NOVA EC2 Instance Bootstrap Script
# Runs on first boot via EC2 User Data

set -euo pipefail

PROJECT_NAME="${project_name}"
DOMAIN_NAME="${domain_name}"

echo "[bootstrap] Starting instance bootstrap..."

# Update system
dnf update -y

# Install Docker
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
 -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Install CloudWatch Agent
dnf install -y amazon-cloudwatch-agent

# Create application directory
mkdir -p /opt/nova
chown ec2-user:ec2-user /opt/nova

# Create backup directory
mkdir -p /opt/nova/infrastructure/backups/postgres
chown -R 999:999 /opt/nova/infrastructure/backups

# Install fail2ban
dnf install -y fail2ban
systemctl enable --now fail2ban

# Install logrotate
dnf install -y logrotate

echo "[bootstrap] Instance bootstrap complete."
