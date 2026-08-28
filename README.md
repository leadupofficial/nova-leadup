# NOVA Monorepo
> Voice and Visual Companion platform

## Quick Start

### Prerequisites
- Node.js >= 20
- npm >= 10
- Docker & Docker Compose
- Git

### Setup

```bash
# Clone the repository
git clone <repository-url> nova && cd nova

# Install dependencies
npm install

# Start the local stack (PostgreSQL, Redis, MinIO)
npm run docker:up

# Run database migrations
npm run db:migrate

# Start all services in development mode
npm run dev
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build all packages and services |
| `npm run dev` | Start all services in dev mode |
| `npm run lint` | Lint all packages and services |
| `npm run type-check` | TypeScript type checking |
| `npm run test` | Run all tests |
| `npm run format` | Format all files with Prettier |
| `npm run docker:up` | Start local dev stack |
| `npm run docker:down` | Stop local dev stack |
| `npm run docker:reset` | Reset local dev stack (removes volumes) |
| `npm run db:migrate` | Run database migrations |
| `npm run db:seed` | Seed the database |

## Repository Structure

```
nova/
├── apps/ # Frontend applications
│ └── web/ # Next.js web application
├── services/ # Backend services
│ ├── api/ # REST/GraphQL API service
│ └── workers/ # Background job workers
├── packages/ # Shared packages
│ ├── config/ # Shared ESLint, Prettier, TS configs
│ ├── types/ # Shared TypeScript types/interfaces
│ └── utils/ # Shared utility functions
├── infrastructure/ # IaC (Terraform, CloudFormation)
├── docs/ # Documentation
│ ├── api/ # OpenAPI specifications
│ └── contracts/ # Event contract schemas
└── .github/ # CI/CD workflows
```

## Environment Variables

Copy `.env.example` to `.env.local` and configure:

```bash
cp .env.example .env.local
```

See `.env.example` for all available variables.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system architecture.

## Contributing

See [docs/contributing.md](docs/contributing.md) for contribution guidelines.
