# SSRF Defense and Tool Execution Isolation — NOVA Platform

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. SSRF (Server-Side Request Forgery) Defense

### 1.1 Threat
AI tools that fetch web content or execute network requests can be manipulated to access internal services, cloud metadata endpoints, or other restricted resources.

### 1.2 Defense Layers

#### Layer 1: URL Allowlisting
```typescript
// Only allow requests to explicitly approved domains
const ALLOWED_HOSTS = new Set([
 'api.openai.com',
 'api.anthropic.com',
 // Add approved external services
]);

function isAllowedUrl(url: URL): boolean {
 // Block private IP ranges
 const blockedRanges = [
 '10.0.0.0/8',
 '172.16.0.0/12',
 '192.168.0.0/16',
 '127.0.0.0/8',
 '169.254.0.0/16', // link-local (cloud metadata!)
 '0.0.0.0/8',
 ];
 if (isPrivateIP(url.hostname, blockedRanges)) {
 throw new Error('Request to private IP range blocked');
 }

 // Block cloud metadata endpoints specifically
 if (url.hostname === '169.254.169.254' || url.hostname === 'metadata.google.internal') {
 throw new Error('Cloud metadata access blocked');
 }

 // Allowlist check
 if (!ALLOWED_HOSTS.has(url.hostname)) {
 throw new Error(`Host ${url.hostname} not in allowlist`);
 }

 return true;
}
```

#### Layer 2: Network Policies (Docker/Kubernetes)
```yaml
# Docker network isolation — workers cannot reach admin directly
networks:
 nova-network:
 driver: bridge
 internal: false

# Network policy in Kubernetes:
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
 name: workers-network-policy
spec:
 podSelector:
 matchLabels:
 app: workers
 policyTypes:
 - Egress
 egress:
 - to:
 - ipBlock:
 cidr: 0.0.0.0/0
 except:
 - 10.0.0.0/8
 - 172.16.0.0/12
 - 192.168.0.0/16
 - 169.254.0.0/16
 ports:
 - protocol: TCP
 port: 443
 - protocol: TCP
 port: 80
```

#### Layer 3: HTTP Client Hardening
```typescript
import http from 'http';
import https from 'https';
import { URL } from 'url';

const agent = new https.Agent({
 maxSockets: 10,
 rejectUnauthorized: true,
 minVersion: 'TLSv1.2',
});

function safeFetch(urlStr: string, opts: RequestInit = {}): Promise<Response> {
 const url = new URL(urlStr);

 // Validate URL
 if (url.protocol !== 'https:') {
 throw new Error('Only HTTPS URLs allowed');
 }

 isAllowedUrl(url); // throws if not allowed

 // Disable following redirects to prevent redirect-based SSRF
 opts.redirect = 'manual';
 if (opts.headers) {
 (opts.headers as Record<string, string>)['X-Forwarded-For'] = ''; // Don't leak internal IPs
 }

 return fetch(urlStr, { ...opts, agent });
}
```

### 1.3 DNS Rebinding Protection
- Pin DNS resolution at connection time
- Validate IP after DNS resolution, before connecting
- Use TTL=0 for external requests to prevent rebinding

---

## 2. Tool Execution Isolation

### 2.1 Architecture
```
┌──────────┐ ┌──────────────┐ ┌──────────────┐
│ AI Agent │────▶│ Tool Gateway │────▶│ Tool Runner │
│ │ │ (validate, │ │ (sandboxed │
│ │ │ filter) │ │ process) │
└──────────┘ └──────────────┘ └──────────────┘
```

### 2.2 Tool Execution Allowlist
```typescript
// Only pre-approved tools can execute
const APPROVED_TOOLS = {
 'web_search': {
 execute: 'web_search_tool',
 allowed_domains: ['*'], // configured per search provider
 max_results: 10,
 timeout_ms: 10_000,
 },
 'web_fetch': {
 execute: 'http_fetch',
 allowed_domains: ALLOWED_HOSTS,
 max_content_length: 1_000_000, // 1MB
 timeout_ms: 15_000,
 allow_redirects: false,
 },
 'code_execution': {
 execute: 'sandboxed_exec',
 allowed_paths: ['/sandbox/'],
 max_execution_time_ms: 5_000,
 network_access: false,
 },
};
```

### 2.3 Content Isolation
- Tool execution happens in isolated containers or processes
- No shared filesystem state between executions
- Network access restricted to allowlisted destinations
- Execution results validated before returning to agent
- All tool calls logged in audit trail

### 2.4 Input Sanitization
```typescript
function sanitizeToolInput(input: unknown, schema: z.ZodSchema): unknown {
 const parsed = schema.safeParse(input);
 if (!parsed.success) {
 throw new Error(`Invalid tool input: ${parsed.error.message}`);
 }
 // Remove any control characters, null bytes
 const cleaned = JSON.parse(
 JSON.stringify(parsed.data)
 .replace(/[\x00-\x1F\x7F]/g, '')
 );
 return cleaned;
}
```

---

## 3. Monitoring

- Log all tool execution attempts (success and failure)
- Alert on tool execution to non-allowlisted destinations
- Rate limit tool execution per user/session
- Implement circuit breakers for external tool APIs
