# NOVA Production Readiness Plan

## Current State Assessment

### What Works ✅
- Database package: Builds successfully
- Shared types: Builds successfully
- Project structure: Well-organized monorepo
- Dependencies: Core packages installed

### What Needs Fixing ❌
1. **Memory package**: 11 TypeScript errors (import paths, type mismatches)
2. **Workflow-engine**: 2 TypeScript errors (generic type constraints)
3. **Mobile app**: Missing production dependencies and native features
4. **Backend services**: Multiple packages have import/export issues
5. **EAS Build**: Not configured
6. **App Store assets**: Missing

---

## Phase 1: Fix Build Errors (Priority: CRITICAL)

### 1.1 Memory Package (11 errors)
**File**: `packages/memory/src/store.ts`
- Fix import paths: `eq`, `and`, `desc` from `drizzle-orm` not schema
- Fix type imports: Remove `Database` type import (not exported)
- Fix status values: 'active' and 'corrected' not in MemoryStatus enum

**File**: `packages/memory/src/search.ts`
- Fix import paths: `sql` from `drizzle-orm`, not schema
- Fix type conversions with proper casting

**File**: `packages/memory/src/embedding.ts`
- Fix null safety in cosine similarity calculation

**File**: `packages/memory/src/extraction.ts`
- Add explicit type annotation to map callback

**File**: `packages/shared-types/src/types.ts`
- Expand MemoryStatus to include 'active' and 'corrected'

**Estimated time**: 30 minutes

### 1.2 Workflow-engine Package (2 errors)
**File**: `services/workflow-engine/src/index.ts`
- Fix generic Map types: `Map<string, JobDefinition<any, any>>`
- Fix return type casting for handler output

**Estimated time**: 10 minutes

### 1.3 Fix All Import Paths
- Ensure all packages import from correct paths
- Add missing path mappings in tsconfig.base.json

**Estimated time**: 20 minutes

**Total Phase 1**: ~1 hour

---

## Phase 2: Mobile App Production Setup (Priority: HIGH)

### 2.1 Install Missing Dependencies
```json
{
 "expo-secure-store": "~13.0.0",
 "expo-haptics": "~13.0.0",
 "expo-notifications": "~0.19.0",
 "expo-application": "~5.0.0",
 "expo-constants": "~16.0.0",
 "expo-device": "~6.0.0"
}
```

### 2.2 Configure EAS Build
**File**: `apps/mobile/eas.json`
```json
{
 "cli": {
 "version": ">= 3.0.0"
 },
 "build": {
 "development": {
 "developmentClient": true,
 "distribution": "internal"
 },
 "preview": {
 "distribution": "internal",
 "ios": {
 "simulator": true
 }
 },
 "production": {
 "ios": {
 "autoIncrement": true
 },
 "android": {
 "autoIncrement": true
 }
 }
 }
}
```

### 2.3 Update app.json
- Add bundle identifiers
- Add iOS/Android configs
- Add icons and splash screens placeholders
- Configure deep linking
- Add privacy permissions

**Estimated time**: 2 hours

---

## Phase 3: Backend Services (Priority: HIGH)

### 3.1 Fix All Service Builds
Run through each service and fix:
- Missing dependencies
- Import path issues
- Type mismatches

Services to fix:
- services/api
- services/agent-orchestrator
- services/integration-service
- services/notification-service
- services/realtime-gateway
- services/worker

**Estimated time**: 2-3 hours

### 3.2 Environment Configuration
Create `.env.example` with all required variables:
- Database URLs
- API keys
- Redis configuration
- AWS credentials
- Auth secrets
- Third-party service keys

**Estimated time**: 30 minutes

---

## Phase 4: Production Infrastructure (Priority: MEDIUM)

### 4.1 Docker Configuration
- Fix Dockerfiles for all services
- Update docker-compose.prod.yml
- Add health checks
- Configure logging

**Estimated time**: 1 hour

### 4.2 CI/CD Pipeline
- Update GitHub Actions workflows
- Add build, test, deploy stages
- Configure secrets
- Add deployment targets

**Estimated time**: 1 hour

### 4.3 Monitoring & Observability
- Configure logging
- Add error tracking (Sentry)
- Add performance monitoring
- Set up alerts

**Estimated time**: 1 hour

---

## Phase 5: App Store Preparation (Priority: MEDIUM)

### 5.1 Assets Required
- App icon (all sizes: 1024x1024, 180x180, 167x167, etc.)
- Splash screen (1284x2778)
- App Store screenshots (various sizes)
- App Store description
- Privacy policy URL
- Support URL

### 5.2 iOS Configuration
- Update Info.plist with permissions
- Configure push notification capabilities
- Set up App Store Connect
- Configure TestFlight

### 5.3 Android Configuration
- Update AndroidManifest.xml
- Configure Google Play Console
- Set up signing keys

**Estimated time**: 3-4 hours

---

## Phase 6: Testing & Quality (Priority: MEDIUM)

### 6.1 Unit Tests
- Fix existing tests
- Add missing test coverage (80% minimum)
- Configure test runners

### 6.2 Integration Tests
- Test API endpoints
- Test database operations
- Test authentication flow

### 6.3 E2E Tests
- Test critical user flows
- Test mobile app screens

**Estimated time**: 4-6 hours

---

## Recommended Execution Order

**Week 1:**
1. Day 1-2: Fix all build errors (Phase 1)
2. Day 3-4: Mobile app setup + EAS config (Phase 2)
3. Day 5: Backend services (Phase 3)

**Week 2:**
1. Day 1-2: Infrastructure + CI/CD (Phase 4)
2. Day 3-4: App Store preparation (Phase 5)
3. Day 5: Testing + final verification (Phase 6)

---

## Immediate Next Steps

1. Fix memory package errors (30 min)
2. Fix workflow-engine errors (10 min)
3. Run full build to verify (5 min)
4. Install mobile dependencies (15 min)
5. Configure EAS build (30 min)

**Should I proceed with executing Phase 1 (fixing all build errors) now?**
