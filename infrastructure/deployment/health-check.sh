#!/bin/bash
# NOVA Production Health Check Script
# Verifies all services are running and healthy
#
# Usage: ./health-check.sh [--format json]
# Exit codes:
# 0 — All healthy
# 1 — One or more services unhealthy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST="${HOST:-nova.leadup.in}"
FORMAT="${1:-text}"

# Services to check
SERVICES=(
 "nginx|/health/live|nginx reverse proxy"
 "api|/health/ready|API service"
 "auth|/health/live|Auth service"
 "admin|/health/live|Admin console"
)

FAILED=0
TOTAL=${#SERVICES[@]}

if [[ "$FORMAT" == "json" ]]; then
 echo -n '{"checks":['
 FIRST=true
fi

for i in "${!SERVICES[@]}"; do
 SERVICE="${SERVICES[$i]}"
 IFS='|' read -r NAME PATH LABEL <<< "$SERVICE"

 URL="https://${HOST}${PATH}"
 STATUS="UNKNOWN"
 MESSAGE=""

 # Check with curl (5s timeout, follow redirects)
 HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 --location "$URL" 2>/dev/null || echo "000")

 case "$HTTP_CODE" in
 200|204) STATUS="HEALTHY" ;;
 000) STATUS="UNREACHABLE"
 MESSAGE="Connection failed or timeout"
 ;;
 301|302) STATUS="REDIRECT"
 MESSAGE="Unexpected redirect"
 ;;
 401|403) STATUS="AUTH_REQUIRED" ;;
 500|502|503|504) STATUS="UNHEALTHY"
 MESSAGE="HTTP ${HTTP_CODE}"
 ;;
 *) STATUS="UNHEALTHY"
 MESSAGE="HTTP ${HTTP_CODE}"
 ;;
 esac

 if [[ "$STATUS" == "HEALTHY" ]]; then
 echo -e " \033[0;32m✓\033[0m ${LABEL} (${HTTP_CODE})"
 else
 FAILED=$((FAILED + 1))
 echo -e " \033[0;31m✗\033[0m ${LABEL} — ${STATUS} (${HTTP_CODE}) ${MESSAGE}"
 fi

 if [[ "$FORMAT" == "json" ]]; then
 if [[ "$FIRST" == "true" ]]; then
 FIRST=false
 else
 echo -n ','
 fi
 echo -n "{\"service\":\"${NAME}\",\"status\":\"${STATUS}\",\"http_code\":\"${HTTP_CODE}\"}"
 fi
done

if [[ "$FORMAT" == "json" ]]; then
 echo -n '],"healthy":'"${TOTAL}"',"failed":'"${FAILED}"',"overall":"'
 if [[ "$FAILED" -eq 0 ]]; then
 echo -n 'healthy"}'
 else
 echo -n 'unhealthy"}'
 fi
 echo ""
fi

echo ""
if [[ "$FAILED" -eq 0 ]]; then
 echo -e "\033[0;32mAll ${TOTAL} services healthy.\033[0m"
 exit 0
else
 echo -e "\033[0;31m${FAILED}/${TOTAL} services unhealthy.\033[0m"
 exit 1
fi
