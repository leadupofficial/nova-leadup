# NOVA Leadup — Deployment Runbook
# Step-by-step procedures for deploying NOVA to production.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Local Development (Docker Compose)](#local-development-docker-compose)
3. [Kubernetes Deployment](#kubernetes-deployment)
4. [Terraform Infrastructure Provisioning](#terraform-infrastructure-provisioning)
5. [Verification](#verification)
6. [Rollback](#rollback)

---

## Prerequisites

### Required Tools
| Tool | Version | Purpose |
|------|---------|---------|
| Docker | 24+ | Container runtime |
| Docker Compose | 2.20+ | Service orchestration |
| kubectl | 1.28+ | Kubernetes CLI |
| Terraform | 1.6+ | Infrastructure as Code |
| pnpm | 8+ | Package manager |
| Node.js | 22+ | Runtime |
| openssl | any | Secret generation |

### Required Access
- AWS account with permissions for the NOVA project
- Kubernetes cluster access (kubeconfig configured)
- Container registry access (ghcr.io or your registry)
- DNS management for `nova.leadup.in`

---

## Local Development (Docker Compose)

### 1. Clone and Setup

```bash
git clone <repository-url> && cd NOVA-Leadup

# Copy environment template
cp .env.example .env

# Generate secure secrets
openssl rand -base64 64 > /tmp/jwt-secret.txt
openssl rand -base64 64 > /tmp/jwt-refresh-secret.txt
```

### 2. Configure Environment

Edit `.env` with your local values:

```bash
# Database
DATABASE_URL=postgres://nova:nova@localhost:5432/nova
REDIS_URL=redis://:nova@localhost:6379

# JWT (use generated secrets above)
JWT_SECRET=<from /tmp/jwt-secret.txt>
JWT_REFRESH_SECRET=<from /tmp/jwt-refresh-secret.txt>

# AI Providers (optional for local)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Storage
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=nova
S3_SECRET_KEY=nova-secret
S3_BUCKET=nova-assets
```

### 3. Start Services

```bash
# From the project root (docker-compose.yml is in infrastructure/docker/)
cd infrastructure/docker

# Start all services
docker compose up -d

# Verify all services are healthy
docker compose ps

# Expected output: all services show "healthy" or "running"
```

### 4. Run Migrations

```bash
# Run database migrations
cd ../../services/api
pnpm run db:migrate

cd ../auth
pnpm run db:migrate
```

### 5. Start Development Servers

```bash
# Terminal 1 — API
pnpm --filter @nova/api run dev

# Terminal 2 — Auth
pnpm --filter @nova/auth run dev

# Terminal 3 — Admin
pnpm --filter @nova/admin run dev

# Terminal 4 — Realtime Gateway
pnpm --filter @nova/realtime-gateway run dev

# Terminal 5 — Frontend (Next.js)
pnpm --filter @nova/web run dev
```

### 6. Verify Local Deployment

```bash
# API health
curl http://localhost:3000/health

# Auth health
curl http://localhost:3003/health

# Realtime gateway health
curl http://localhost:3001/health

# MinIO console
open http://localhost:9001 # login: nova / nova-secret
```

---

## Kubernetes Deployment

### 1. Prerequisites

```bash
# Verify cluster access
kubectl cluster-info
kubectl get nodes

# Verify namespace doesn't exist yet
kubectl get namespace nova || echo "Namespace will be created"
```

### 2. Generate Kubernetes Secrets

```bash
# Generate secure values
JWT_SECRET=$(openssl rand -base64 64)
REDIS_PASSWORD=$(openssl rand -base64 32)
DB_PASSWORD=$(openssl rand -base64 32)

# Create namespace
kubectl apply -f infrastructure/kubernetes/namespace.yaml

# Create secrets
kubectl create secret generic nova-secrets \
 --from-literal=DATABASE_URL="postgres://nova:${DB_PASSWORD}@nova-postgres:5432/nova" \
 --from-literal=REDIS_URL="redis://:${REDIS_PASSWORD}@nova-redis:6379" \
 --from-literal=REDIS_PASSWORD="${REDIS_PASSWORD}" \
 --from-literal=POSTGRES_PASSWORD="${DB_PASSWORD}" \
 --from-literal=JWT_SECRET="${JWT_SECRET}" \
 --from-literal=JWT_REFRESH_SECRET=$(openssl rand -base64 64) \
 --from-literal=API_KEY_SECRET=$(openssl rand -base64 64) \
 --from-literal=AUTH_ENCRYPTION_KEY=$(openssl rand -base64 32) \
 --from-literal=ANTHROPIC_API_KEY="your-anthropic-key" \
 --from-literal=OPENAI_API_KEY="your-openai-key" \
 --from-literal=DEEPGRAM_API_KEY="your-deepgram-key" \
 --from-literal=ELEVENLABS_API_KEY="your-elevenlabs-key" \
 --from-literal=SARVAM_API_KEY="your-sarvam-key" \
 --from-literal=S3_ACCESS_KEY="nova" \
 --from-literal=S3_SECRET_KEY="<SECRET_a4017de4>" \
 --namespace=nova
```

### 3. Deploy Infrastructure

```bash
# Deploy in dependency order
kubectl apply -f infrastructure/kubernetes/configmap.yaml
kubectl apply -f infrastructure/kubernetes/postgres.yaml
kubectl apply -f infrastructure/kubernetes/redis.yaml

# Wait for database and Redis to be ready
kubectl wait --for=condition=ready pod -l app=nova-postgres --timeout=120s
kubectl wait --for=condition=ready pod -l app=nova-redis --timeout=120s
```

### 4. Build and Push Container Images

```bash
# Build images
docker build -t ghcr.io/leadup-technologies/nova-api:latest \
 --target api \
 -f infrastructure/docker/Dockerfile .

docker build -t ghcr.io/leadup-technologies/nova-realtime-gateway:latest \
 --target realtime-gateway \
 -f infrastructure/docker/Dockerfile .

# Push to registry
docker push ghcr.io/leadup-technologies/nova-api:latest
docker push ghcr.io/leadup-technologies/nova-realtime-gateway:latest
```

### 5. Deploy Application Services

```bash
# Deploy API
kubectl apply -f infrastructure/kubernetes/api-deployment.yaml
kubectl apply -f infrastructure/kubernetes/api-service.yaml

# Deploy Realtime Gateway
kubectl apply -f infrastructure/kubernetes/realtime-deployment.yaml

# Deploy Autoscaling
kubectl apply -f infrastructure/kubernetes/hpa.yaml

# Wait for deployments
kubectl rollout status deployment/nova-api --timeout=120s
kubectl rollout status deployment/nova-realtime --timeout=120s
```

### 6. Deploy Networking

```bash
# Deploy Ingress (requires cert-manager installed)
kubectl apply -f infrastructure/kubernetes/ingress.yaml

# Verify TLS certificate provisioning
kubectl get certificate -n nova
kubectl describe certificate nova-tls -n nova
```

### 7. Verify Kubernetes Deployment

```bash
# Check all pods are running
kubectl get pods -n nova

# Check services
kubectl get services -n nova

# Check HPA status
kubectl get hpa -n nova

# Check ingress
kubectl get ingress -n nova

# Test connectivity
kubectl port-forward service/nova-api 3000:3000 -n nova
curl http://localhost:3000/health
```

---

## Terraform Infrastructure Provisioning

### 1. Prerequisites

```bash
# Install Terraform
brew install terraform # macOS
# or: tfenv install 1.6.0 # using tfenv

# Configure AWS credentials
export AWS_PROFILE=nova-production
aws sts get-caller-identity # verify access
```

### 2. Initialize Terraform

```bash
cd infrastructure/terraform

# Copy example variables
cp terraform.tfvars.example terraform.tfvars

# Edit terraform.tfvars with your values
# - aws_region
# - key_pair_name (for SSH access)
# - ssl_certificate_arn (ACM certificate)
# - allowed_ssh_cidr (restrict to your IP)

# Initialize Terraform
terraform init

# Validate configuration
terraform validate
```

### 3. Plan and Apply

```bash
# Review planned changes
terraform plan -out=tfplan

# Apply infrastructure
terraform apply tfplan

# Save outputs
terraform output > infrastructure-outputs.txt
```

### 4. Update Infrastructure

```bash
# Make changes to .tf files
terraform plan
terraform apply
```

---

## Verification

### Health Check Endpoints

| Service | Endpoint | Expected Response |
|---------|----------|-------------------|
| API | `GET /health` | `{"status":"ok","service":"api"}` |
| Auth | `GET /health` | `{"status":"ok","service":"auth"}` |
| Realtime | `GET /health` | `{"status":"ok","service":"realtime-gateway"}` |
| PostgreSQL | `pg_isready` | `accepting connections` |
| Redis | `redis-cli ping` | `PONG` |
| MinIO | `GET /minio/health/live` | `200 OK` |

### Smoke Tests

```bash
# 1. API responds
curl -f https://nova.leadup.in/health

# 2. Auth endpoint responds
curl -f https://nova.leadup.in/auth/health

# 3. WebSocket endpoint is reachable
curl -f -H "Upgrade: websocket" https://ws.nova.leadup.in/ws/health

# 4. Database connection works
kubectl exec -n nova -it deployment/nova-api -- \
 node -e "const { Pool} = require('pg'); new Pool({connectionString: process.env.DATABASE_URL}).query('SELECT 1').then(() => console.log('DB OK'))"

# 5. Redis connection works
kubectl exec -n nova -it deployment/nova-api -- \
 node -e "const Redis = require('ioredis'); const r = new Redis(process.env.REDIS_URL); r.ping().then(() => console.log('Redis OK'))"
```

---

## Rollback

See [rollback.md](./rollback.md) for detailed rollback procedures.

### Quick Rollback (Kubernetes)

```bash
# Rollback deployment to previous version
kubectl rollout undo deployment/nova-api -n nova
kubectl rollout undo deployment/nova-realtime -n nova

# Verify rollback
kubectl rollout status deployment/nova-api -n nova
kubectl get pods -n nova
```

### Quick Rollback (Terraform)

```bash
cd infrastructure/terraform
terraform state list # find resources to revert
terraform import <resource> <id> # if needed
terraform apply # re-apply previous state
```
