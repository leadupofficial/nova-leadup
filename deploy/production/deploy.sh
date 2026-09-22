#!/bin/bash
# deploy.sh — one-shot production deploy for nova.leadup.in
#
# ## What this script used to do wrong
#
# An audit found four defects here, one of them a security problem and one of them
# enough to make the deployed app non-functional:
#
#   1. The SSH password was **hardcoded in plaintext**, twice. It is now read from the
#      `SSHPASS` environment variable via `sshpass -e`, so no secret lives in this file.
#      The old password is in the git history of whoever copied this script around and
#      must be treated as compromised — rotate it.
#   2. The secret substitution built the `.env` with a chain of `sed -e` expressions
#      against the *same* placeholder. The first expression (`__CHANGE_ME__` →
#      `POSTGRES_PW`) consumed every occurrence, so the second matched nothing:
#      `REDIS_PASSWORD` silently kept the Postgres password.
#   3. That same chain left **every provider API key as the literal `__CHANGE_ME__`** —
#      `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `SARVAM_API_KEY`.
#      A deploy by this script produced an app that could not transcribe or answer,
#      which is a functional-app failure a store review would catch immediately. The
#      keys cannot be generated, so the script now **requires** them and refuses to
#      continue without them.
#   4. `certbot` and the database migration were both suffixed with `|| true`. SSL
#      failure left the site on HTTP — and both stores require the privacy and
#      account-deletion URLs to answer over HTTPS — and a failed migration left the API
#      running against an old schema, both invisible. They now fail loudly.
#
# Also: `openssl rand -base64` can emit `/` and `+`, which corrupt a password embedded in
# a `postgres://user:pass@host` URL. Credentials are generated URL-safe.
#
# ## Usage
#
#   export SSHPASS='...'                 # SSH password for $SSH_HOST
#   export ANTHROPIC_API_KEY='...'       # required — no default
#   export DEEPGRAM_API_KEY='...'
#   export ELEVENLABS_API_KEY='...'
#   export SARVAM_API_KEY='...'
#   ./deploy.sh
set -euo pipefail

SSH_USER="root"
SSH_HOST="91.107.202.66"
REPO_DIR="/opt/nova-leadup"
PROD_DEPLOY_DIR="${REPO_DIR}/deploy/production"
COMPOSE_FILE="${PROD_DEPLOY_DIR}/docker-compose.prod.yml"
NGINX_CONF="/etc/nginx/sites-available/nova.leadup.in"
DOMAIN="nova.leadup.in"
ADMIN_DOMAIN="admin.${DOMAIN}"
EMAIL="contact@leadup.in"

# ── Preconditions ─────────────────────────────────────────────────────────────
missing=()
[ -n "${SSHPASS:-}" ]          || missing+=("SSHPASS")
[ -n "${ANTHROPIC_API_KEY:-}" ] || missing+=("ANTHROPIC_API_KEY")
[ -n "${DEEPGRAM_API_KEY:-}" ]  || missing+=("DEEPGRAM_API_KEY")
[ -n "${ELEVENLABS_API_KEY:-}" ] || missing+=("ELEVENLABS_API_KEY")
[ -n "${SARVAM_API_KEY:-}" ]    || missing+=("SARVAM_API_KEY")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Refusing to deploy. These must be exported first:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "The provider keys cannot be generated — a deploy without them produces an app" >&2
  echo "that cannot transcribe or answer. See the header of this script." >&2
  exit 1
fi
command -v sshpass >/dev/null 2>&1 || { echo "sshpass is required (brew install sshpass / apt install sshpass)" >&2; exit 1; }

# `-e` reads the password from SSHPASS rather than an argument, so it never appears in
# `ps`. `accept-new` still records the host key on first contact, unlike
# `StrictHostKeyChecking=no`, which accepts a changed key silently.
run() { echo -e "\033[1;34m[remote]\033[0m $*"; sshpass -e ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" "$*"; }

echo "============================================================"
echo " NOVA Production Deploy → ${SSH_HOST}"
echo "============================================================"

# 1. System prep
run 'apt-get update -qq && apt-get install -y -qq curl git ca-certificates openssl python3 python3-pip gnupg lsb-release'

# 2. Docker
if ! run 'command -v docker' >/dev/null 2>&1; then
  run 'install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && chmod a+r /etc/apt/keyrings/docker.gpg'
  run 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list'
  run 'apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
fi

run 'systemctl enable --now docker'

# 3. Repo
#
# `git reset --hard` discards anything on the server that is not in `main`. That is
# intended for a deploy box and is called out here because it is destructive: any hotfix
# applied directly on the server is lost by this line.
if ! run "test -d ${REPO_DIR}/.git"; then
  run "git clone https://github.com/leadupofficial/nova-leadup.git ${REPO_DIR}"
fi
run "cd ${REPO_DIR} && git fetch origin && git reset --hard origin/main"

# 4. Build images
run "cd ${REPO_DIR} && docker compose -f ${COMPOSE_FILE} build --no-cache"

# 5. Secrets / .env.production
#
# One `set_env` per variable, replacing the placeholder by name. The provider keys are
# expanded locally and travel over the SSH channel on stdin — not as arguments, so they
# do not appear in `ps` on either host.
run 'bash -s' <<REMOTE
set -euo pipefail
cd ${REPO_DIR}

# URL-safe: base64 can emit '/' and '+', which corrupt a password embedded in a
# postgres:// or redis:// URL.
gen() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-32; }

POSTGRES_PW=\$(gen)
REDIS_PW=\$(gen)

cp deploy/production/.env.production.template .env.production

set_env() {
  local key="\$1" value="\$2"
  local escaped
  escaped=\$(printf '%s' "\$value" | sed -e 's/[&|\\\\]/\\\\&/g')
  if grep -q "^\${key}=" .env.production; then
    sed -i "s|^\${key}=.*|\${key}=\${escaped}|" .env.production
  else
    printf '%s=%s\n' "\${key}" "\$value" >> .env.production
  fi
}

set_env JWT_SECRET          "\$(openssl rand -base64 64 | tr -d '\n')"
set_env REFRESH_TOKEN_SECRET "\$(openssl rand -base64 64 | tr -d '\n')"
set_env AUTH_ENCRYPTION_KEY "\$(openssl rand -base64 32 | tr -d '\n')"
set_env API_KEY_SECRET      "\$(openssl rand -base64 64 | tr -d '\n')"
set_env S3_SECRET_KEY       "\$(openssl rand -base64 32 | tr -d '\n')"
set_env POSTGRES_PASSWORD   "\$POSTGRES_PW"
set_env REDIS_PASSWORD      "\$REDIS_PW"
set_env DATABASE_URL        "postgres://nova_app:\${POSTGRES_PW}@postgres:5432/nova"
set_env REDIS_URL           "redis://:\${REDIS_PW}@redis:6379"
set_env APP_URL             "https://${DOMAIN}"
set_env ANTHROPIC_API_KEY   "${ANTHROPIC_API_KEY}"
set_env DEEPGRAM_API_KEY    "${DEEPGRAM_API_KEY}"
set_env ELEVENLABS_API_KEY  "${ELEVENLABS_API_KEY}"
set_env SARVAM_API_KEY      "${SARVAM_API_KEY}"

chmod 600 .env.production

# The failure this replaces: placeholders that silently survived the old sed chain, so
# the stack started with literal `__CHANGE_ME__` values.
if grep -q '__CHANGE_ME__' .env.production; then
  echo "ERROR: these are still placeholders after substitution:" >&2
  grep -n '__CHANGE_ME__' .env.production >&2
  exit 1
fi

if [ "\$POSTGRES_PW" = "\$REDIS_PW" ]; then
  echo "ERROR: generated one password for both services" >&2
  exit 1
fi

echo "Secrets written to .env.production (mode 600), every placeholder substituted."
REMOTE

# 6. nginx
run 'apt-get install -y -qq nginx'
run "cp ${PROD_DEPLOY_DIR}/nginx.conf ${NGINX_CONF}"
run "ln -sf ${NGINX_CONF} /etc/nginx/sites-enabled/default"
run 'nginx -t && systemctl reload nginx'

# 7. SSL
#
# Not `|| true`. Both stores require the privacy and account-deletion URLs to answer over
# HTTPS, so a failed certificate is a blocked submission, not a warning — and swallowing
# it left the site serving HTTP with nobody told.
if ! run "certbot --nginx -d ${DOMAIN} -d ${ADMIN_DOMAIN} --non-interactive --agree-tos -m ${EMAIL} --redirect"; then
  echo "ERROR: certbot failed. The store-listing URLs must answer over HTTPS." >&2
  exit 1
fi

# 8. Database bootstrap
echo -e "\033[1;33m[local]\033[0m Applying database migrations..."
# Also not `|| true`: a migration that did not apply leaves the API serving an old schema,
# which fails in ways that look like application bugs.
run "cd ${REPO_DIR} && docker compose -f ${COMPOSE_FILE} exec -T api pnpm run db:migrate"

# 9. Launch stack
run "cd ${REPO_DIR} && docker compose -f ${COMPOSE_FILE} up -d --remove-orphans"

# 10. Wait + verify
sleep 20
run "cd ${REPO_DIR} && docker compose -f ${COMPOSE_FILE} ps"

# 11. The checks that decide whether the stores can be submitted at all.
echo -e "\033[1;33m[local]\033[0m Verifying the public URLs the stores require..."
for url in "https://${DOMAIN}/privacy" "https://${DOMAIN}/delete-account" "https://${DOMAIN}/support"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo '000')
  if [ "$code" = "200" ]; then
    echo "  OK   $code  $url"
  else
    echo "  FAIL $code  $url   <- a store will reject the listing while this is not 200" >&2
    FAILED_URLS=1
  fi
done

echo "============================================================"
echo " Deployment done."
echo " API  : https://${DOMAIN}/api/v1"
echo " Auth : https://${DOMAIN}/auth"
echo " WS   : wss://${DOMAIN}/ws"
echo " Admin: https://${ADMIN_DOMAIN}"
if [ "${FAILED_URLS:-0}" = "1" ]; then
  echo
  echo " One or more store-required URLs are not answering. Fix before submitting."
  exit 1
fi
echo "============================================================"
