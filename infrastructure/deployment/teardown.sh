#!/bin/bash
# NOVA Infrastructure Teardown Script
# Destroys all AWS resources provisioned by Terraform
#
# Usage: ./teardown.sh [--force]
# --force: skip confirmation prompt

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")/terraform"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
 FORCE=true
fi

echo -e "${RED}=========================================="
echo " NOVA Production Teardown"
echo -e "==========================================${NC}"
echo ""
echo -e "${YELLOW}WARNING: This will DESTROY all production infrastructure:${NC}"
echo " - EC2 instance"
echo " - RDS PostgreSQL database (with all data)"
echo " - ElastiCache Redis"
echo " - ALB and networking"
echo " - S3 buckets"
echo ""
echo -e "${RED}All data will be permanently lost!${NC}"
echo ""

if [[ "$FORCE" != "true" ]]; then
 read -p "Type 'destroy-nova-production' to confirm: " CONFIRM
 if [[ "$CONFIRM" != "destroy-nova-production" ]]; then
 echo "Aborted."
 exit 0
 fi
fi

echo ""
echo -e "${BLUE}[teardown] Destroying infrastructure...${NC}"

cd "$INFRA_DIR"

# Destroy in reverse order
terraform destroy -var-file="terraform.tfvars" -auto-approve || {
 echo -e "${RED}[teardown] Terraform destroy failed. Manual cleanup may be required.${NC}"
 exit 1
}

echo -e "${GREEN}[teardown] Infrastructure destroyed successfully.${NC}"
