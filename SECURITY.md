# Security Policy

## Supported Versions

| Version | Supported |
| ------- | ------------------ |
| 0.1.x | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in NOVA-Leadup, please report it responsibly.

**Please do NOT open a public GitHub issue for security vulnerabilities.**

### Reporting Process

1. **Email us directly** at security@leadup.in with:
 - A description of the vulnerability
 - Steps to reproduce
 - Potential impact assessment
 - Suggested fix (if any)

2. **We will respond within 48 hours** acknowledging receipt.

3. **We will investigate** and provide a timeline for a fix.

4. **We will credit you** in the security advisory (unless you prefer anonymity).

### Security Best Practices for Contributors

- Never commit secrets, API keys, or credentials to the repository
- Use environment variables for all sensitive configuration
- Follow OWASP guidelines for web application security
- Validate all inputs with Zod schemas
- Use parameterized queries (Drizzle ORM handles this automatically)
- Implement proper authentication and authorization checks
- Keep dependencies up to date and audit for vulnerabilities regularly

### Running Security Scans

```bash
# Audit dependencies for vulnerabilities
pnpm audit

# Run security linting
pnpm lint:security

# Check for exposed secrets
git secret reveal
```
