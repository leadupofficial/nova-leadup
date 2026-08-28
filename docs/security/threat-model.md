# Security Threat Model — NOVA Platform

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. Assets

| Asset | Sensitivity | Description |
|-------|-------------|-------------|
| User credentials | Critical | Passwords, MFA secrets, session tokens |
| Customer data | Critical | Audio transcripts, workspace content, user profiles |
| API keys / secrets | Critical | JWT secrets, encryption keys, third-party API keys |
| Database | Critical | PostgreSQL with pgvector — all application data |
| Service infrastructure | High | API, auth, workers, admin services |
| AI inference layer | High | External LLM API calls (OpenAI, Anthropic, etc.) |

---

## 2. Threat Actors

| Actor | Motivation | Capability |
|-------|-----------|------------|
| External attacker | Data theft, service disruption | Moderate — automated scanning, credential stuffing |
| Malicious insider | Data exfiltration, sabotage | High — internal network access |
| Compromised dependency | Supply chain attack | Varies — depends on upstream package |
| AI tool chain attacker | , data poisoning | High — can inject via tool inputs |
| Nation-state | Espionage, disruption | High — persistent, well-funded |

---

## 3. Threat Scenarios

### 3.1 Authentication & Authorization

| ID | Threat | Impact | Likelihood | Risk | Mitigation |
|----|--------|--------|------------|------|------------|
| T-01 | Credential stuffing on login | Account takeover | High | High | Rate limiting (5 req/min), bcrypt (10 rounds), account lockout after 5 failures |
| T-02 | JWT token theft (XSS, MITM) | Impersonation | Medium | High | Short-lived JWTs (15m), HttpOnly cookies, TLS-only transport |
| T-03 | Session fixation | Account takeover | Low | Medium | Regenerate session ID on login, store server-side in Redis |
| T-04 | Privilege escalation via RBAC bypass | Unauthorized access | Medium | High | Server-side RBAC on every endpoint, deny-by-default |
| T-05 | API key leakage | Unauthorized API access | Medium | High | API keys hashed at rest, scoped to org, rotate on exposure |

### 3.2 Data Protection

| ID | Threat | Impact | Likelihood | Risk | Mitigation |
|----|--------|--------|------------|------|------------|
| T-06 | Database breach (SQL injection) | Full data exfiltration | Medium | Critical | Parameterized queries, ORM, input validation |
| T-07 | Data in transit interception | Data exposure | Low | Medium | TLS 1.3 everywhere, no HTTP in production |
| T-08 | Unencrypted data at rest | Data exposure on disk | Medium | High | pgcrypto for sensitive fields, encrypted volumes |
| T-09 | Insecure S3 object access | Data leak | Medium | High | Private buckets, presigned URLs with expiry, signed requests |

### 3.3 Input Validation & Injection

| ID | Threat | Impact | Likelihood | Risk | Mitigation |
|----|--------|--------|------------|------|------------|
| T-10 | via AI tool input | Data exfiltration, harmful output | High | High | Input sanitization, tool execution sandboxing, content filters |
| T-11 | SSRF via tool execution | Internal network access | Medium | High | Allowlisted targets only, block private IPs, no raw URL passing |
| T-12 | XSS via user content | Session theft, defacement | Medium | Medium | Content-Security-Policy, X-Content-Type-Options, input escaping |
| T-13 | Command injection via tool input | Server compromise | Medium | High | Input allowlisting, no shell execution from user input |

### 3.4 Infrastructure & Supply Chain

| ID | Threat | Impact | Likelihood | Risk | Mitigation |
|----|--------|--------|------------|------|------------|
| T-14 | Vulnerable npm dependencies | RCE, data exfiltration | Medium | High | CI audit scans, Dependabot, lockfile enforcement |
| T-15 | Container escape | Host compromise | Low | Critical | Non-root users, read-only filesystems, no-new-privileges |
| T-16 | Compromised CI/CD pipeline | Malicious code in production | Low | Critical | Signed commits, protected branches, minimal CI permissions |
| T-17 | DDOS / abuse | Service unavailable | Medium | High | Rate limiting, WAF, CDN |
| T-18 | Secret exposure in logs/env | Credential theft | Medium | High | .env in .gitignore, log scrubbing, secret rotation |

### 3.5 AI-Specific Threats

| ID | Threat | Impact | Likelihood | Risk | Mitigation |
|----|--------|--------|------------|------|------------|
| T-19 | | Unauthorized tool execution | High | High | Structured prompts, tool execution allowlists, output validation |
| T-20 | Harmful content generation | Reputation, compliance | Medium | Medium | Content moderation layer, output filtering |
| T-21 | Data poisoning via RAG | Corrupted AI responses | Medium | High | Source verification, content signing, audit trail |
| T-22 | Tool-based SSRF | Internal network access | Medium | High | Tool execution sandbox, URL allowlist, network policies |

---

## 4. Security Architecture

```
┌─────────────┐ ┌──────────────────┐ ┌──────────────┐
│ WAF/CDN │────▶│ API Gateway │────▶│ API Service │
│ (Rate │ │ (CORS, Headers) │ │ (Rate Lim, │
│ limiting) │ │ │ │ Auth) │
└─────────────┘ └──────────────────┘ └──────┬───────┘
 │
 ┌──────────────┐ ┌──────────────┐ │ ┌──────────────┐
 │ Auth Service│────▶│ Redis │◀──┘ │ PostgreSQL │
 │ (JWT, RBAC) │ │ (Cache, │ │ (pgvector) │
 │ │ │ Rate Lim, │ │ (Encrypted) │
 │ │ │ Sessions) │ │ │
 └──────────────┘ └──────────────┘ └──────────────┘
```

### Layer Security Controls

| Layer | Controls |
|-------|----------|
| Network | Private Docker network, container isolation, read-only filesystems |
| Transport | TLS 1.3 (production), no HTTP |
| API Gateway | CORS, security headers, rate limiting, request size limits |
| Auth | JWT (short-lived), refresh tokens (rotating), MFA, bcrypt |
| Data | Parameterized queries, pgcrypto for sensitive fields, connection pooling |
| Secrets | Environment variables, no hardcoding, rotation procedures |
| Monitoring | Structured logging, audit trail, anomaly detection |

---

## 5. Compliance Mapping

| Requirement | Implementation |
|-------------|---------------|
| OWASP Top 10 | Mitigated per section 3 scenarios |
| Data retention | Database backup + S3 lifecycle policies |
| Audit logging | Admin audit-log endpoint (LEA-57/LEA-56) |
| Access control | RBAC with per-org isolation (LEA-57) |
| Secrets management | Environment variables with rotation procedures |
| Incident response | Runbook documented (see incident-response.md) |
| Disaster recovery | Runbook documented (see disaster-recovery.md) |

---

## 6. Review Checklist

- [ ] Threat model reviewed by security team
- [ ] All risks assigned mitigation owner
- [ ] Mitigations implemented in code/CI/CD
- [ ] Runbooks written and stored in `docs/operations/`
- [ ] Secrets rotation schedule established (90-day default)
- [ ] Backup verification tested
- [ ] Incident response drill scheduled
