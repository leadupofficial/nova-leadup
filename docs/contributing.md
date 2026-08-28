# NOVA Contributing Guide

## Development Setup

See [../quickstart.md](../quickstart.md) for setup instructions.

## Code Style

- TypeScript strict mode is enforced across all packages
- ESLint with shared config from `@nova/config`
- Prettier for formatting — `npm run format` to auto-fix

## Commit Messages

Follow conventional commits:
- `feat:` — new features
- `fix:` — bug fixes
- `docs:` — documentation changes
- `refactor:` — code changes that neither fix a bug nor add a feature
- `test:` — adding or updating tests
- `chore:` — maintenance tasks

## Pull Requests

1. Create a feature branch from `develop`
2. Make changes and ensure `npm run lint && npm run type-check && npm run test` passes
3. Open a PR with a clear description
4. Ensure CI passes before requesting review
