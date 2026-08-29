# NOVA — Master Project Document
## Complete Product, UI, API, Integration & AI-Driven Development Blueprint

**Prepared for:** Leadup Technologies, Karur, Tamil Nadu
**Document type:** Consolidated master blueprint (merges all prior planning rounds into one build-ready reference)
**Product code name:** NOVA
**Primary market:** India — Tamil + English (Tanglish) launch experience
**Primary intelligence provider:** Anthropic Claude (Sonnet + Haiku routing)
**Voice providers:** ElevenLabs (realtime/English) + Sarvam AI (Tamil/Indic)
**Primary client:** Android first → iOS → Web/Desktop
**Backend:** Node.js + TypeScript, PostgreSQL + pgvector, Redis, S3-compatible storage
**Development model:** AI-first, Claude-agent-driven build with minimum required human approval gates

---

## How to Use This Document

This is the single source of truth that replaces and merges every earlier planning round in this thread: the original SRD, the ElevenLabs/Sarvam/Claude replan, the "Jarvis-style avatar company" plan, the UI wireframes, the Pro-plan capability review, the Claude Sonnet/Haiku model routing plan, the device-monitoring and notification-control plan, the floating avatar/overlay + translation companion plan, and the voice wake-word plan. Nothing from those rounds is dropped — it is reorganized here into one buildable spec, with an explicit new section (**Section 21**) listing exactly what you (Leadup Technologies) must supply for the build to start.

---

# 1. Executive Summary

NOVA is a private, voice-first personal AI companion with a visible avatar, durable memory, permissioned device/app actions, and business integrations, built specifically around Tamil-English (Tanglish) usage patterns for the Indian market. It is not a chatbot skin — it is meant to feel like a personal assistant that a user can talk to, see respond, trust with information, and authorize to take real actions (create reminders, translate text, summarize meetings, draft messages) without ever silently acting on the user's behalf.

**Core differentiator:** natural Tamil + English + Tanglish conversation, an expressive avatar (with an optional floating overlay across other apps), and a companion that is proactive but never intrusive — every external or sensitive action requires visible confirmation.

**North-star example interaction:**

> "Nova, yesterday Kumar asked about a CRM and website. He said his budget is two lakhs. Save that and remind me Friday morning to call him."

NOVA understands the mixed-language request, proposes the memory for approval, creates a correctly timed reminder, confirms verbally and visually, and never claims something succeeded unless the backend confirms it.

---

# 2. Product Principles

1. **Voice-first, never voice-only.** Every voice feature has a text/visual fallback.
2. **Avatar-led, not avatar-dependent.** The companion works with the avatar turned off.
3. **Personal by permission.** Memory, recordings, notifications access, and overlay are opt-in, visible, and deletable at any time.
4. **Actions are earned through trust.** Reads can be automatic; external/sensitive writes always require confirmation.
5. **Local before cloud where practical.** Wake-word detection and cached reminders work locally; idle microphone audio is never streamed to the cloud.
6. **Multilingual by architecture.** English, Tamil, and Tanglish are launch requirements, not a translation layer bolted on later.
7. **Enterprise-grade controls from day one.** Multi-tenancy, RBAC, audit logs, and observability are foundational, not later add-ons.
8. **Provider independence.** Claude, ElevenLabs, Sarvam, wake-word engine, and avatar renderer sit behind swappable interfaces.
9. **Truthful system behavior.** The agent can never report a tool succeeded when it didn't.
10. **Human approval for consequential actions.** NOVA prepares, proposes, and executes only within configured authority — see Section 18 for how this is minimized without becoming unsafe.

---

# 3. Target Users & Jobs-to-be-Done

| User | Core need | Example ask |
|---|---|---|
| **Personal professional** | Reminders, notes, follow-ups, recall | "What did I promise the client last week?" |
| **Business owner (your primary early market)** | Sales follow-up, client memory, meeting notes, daily briefing | "Which leads need follow-up today? Draft WhatsApp messages, but don't send them." |
| **Team / enterprise user (later phase)** | Governed workspace access, meeting assistance, audit trail | "Summarize this call, identify decisions, propose tasks for my review." |

Given your own business (multi-client social media + local Tamil Nadu business marketing + BNI networking), the first real internal use case is exactly the business-owner persona: client meeting capture, follow-up reminders, and bilingual quotation/message drafting.

---

# 4. Product Scope & Phased Roadmap

## 4.1 MVP — prove the companion loop

```text
User speaks
  → NOVA listens
  → Claude reasons with controlled context
  → approved tool executes
  → result persists
  → NOVA speaks and visibly confirms
```

**MVP includes:** auth/onboarding, Android app, text chat + push-to-talk voice, realtime voice with interruption/captions, avatar states (idle/listening/thinking/speaking/success/warning/offline), English-Tamil-Tanglish detection, persona settings, conversation history, personal tasks/reminders, explicit meeting recording, async transcription/summary/action extraction, memory view with edit/delete, tool confirmation center, privacy center, and a basic admin console.

**MVP excludes:** always-on iOS background hotword, autonomous external messaging, payments/banking/legal-medical decisions, avatar/tool marketplace, full 3D holographic avatar, enterprise claims before security review.

## 4.2 V1 — productivity-ready personal companion

Android local wake word ("Hey Nova") while backgrounded, calendar connection, contacts connection, email draft+send-with-approval, WhatsApp Business approved messaging, opt-in daily briefing and proactive follow-up suggestions, advanced recording with diarization + transcript search, custom persona/avatar/voice, desktop/web companion.

## 4.3 V2 — enterprise workspace companion

Organization workspaces, RBAC, SSO/SAML/OIDC, SCIM, CRM integrations (HubSpot/Zoho/Salesforce), shared team memory with visibility controls, admin policy engine + DLP + retention/legal hold, approved MCP connectors, analytics/billing/usage quotas, audit exports.

## 4.4 V3 — platform and ecosystem

Avatar SDK, integration/tool marketplace, multiple custom domain agents, ambient/desktop presence, regional/self-hosted enterprise deployments.

---

# 5. Complete UI Screen Specification

Every screen below is production-spec (not just visual concept) — includes layout, states, and required behavior. Wireframes are shown as text layouts since they map 1:1 to component structure for React Native build.

## 5.1 Splash & Secure Bootstrap

```text
┌─────────────────────────────────────┐
│                                     │
│              NOVA                   │
│         (breathing pulse logo)      │
│                                     │
│   "Private companion, on your terms"│
│                                     │
│         ● Connecting...             │
│                                     │
└─────────────────────────────────────┘
```
No microphone activation at this stage. States: loading, offline (cached reminders only), maintenance notice, session expired.

## 5.2 Sign In / Account Creation

Methods: phone OTP, email magic link/password, Google/Apple sign-in, enterprise SSO on org domains. Always show plain-language links to terms/privacy, language/region preselection (editable later), and rate-limit/anti-abuse states.

## 5.3 Consent & Permissions Onboarding

Purpose-specific toggle cards — never one bundled "Allow All":

```text
🎙 Microphone        "Needed to hear you during conversations."       [Allow] [Not now]
🔔 Notifications     "Needed to deliver reminders you create."        [Allow] [Not now]
⏺ Recording          "Off by default. You decide when to record."     [Allow] [Not now]
🧠 Memory            "Save approved facts for future conversations."  [Allow] [Not now]
📅 Contacts/Calendar "Optional. Connect only when you want help."     [Allow] [Not now]
```
Each card has a "Learn what is stored" link.

## 5.4 Create Your Companion

```text
Name:            [ NOVA_______________ ]
Personality:     (●) Friendly  ( ) Professional  ( ) Executive  ( ) Companion
Response length: ( ) Brief  (●) Balanced  ( ) Detailed
Speech style:    ( ) Tamil  ( ) English  (●) Auto Tamil-English
Voice:           [ Preview ▶ ]  Female · Tamil (Sarvam)
Avatar:          [ choose starter avatar + background ]

┌─────────────────────────────┐
│      [ AVATAR PREVIEW ]      │  ← expression animates while
│   plays sample voice line    │     sample audio plays
└─────────────────────────────┘
"Voice and avatar can be changed anytime."
```

## 5.5 Home Dashboard (Avatar-First)

```text
┌─────────────────────────────────────┐
│  ☰                    🔔 3    ⚙️   │
├─────────────────────────────────────┤
│        Good morning, Abishek        │
│        Thursday, Aug 27             │
│                                     │
│         ╭───────────────╮           │
│         │   [ AVATAR ]  │           │  Nova, 60% screen height,
│         │   Nova 😊    │           │  subtle breathing idle loop
│         │   ● Ready    │           │
│         ╰───────────────╯           │
│                                     │
│   "How can I help you today?"       │
├─────────────────────────────────────┤
│  ╭─────────────────────────────╮   │
│  │     🎙 Tap to talk           │   │  Primary CTA — glowing
│  │  (or say "Hey Nova")         │   │  gradient button
│  ╰─────────────────────────────╯   │
│                                     │
│  Today's Overview                   │
│  📅 Reminders        3 pending      │
│  ✅ Tasks           5 pending       │
│  💭 Recent memories  4 new          │
├─────────────────────────────────────┤
│  🏠      💬      ✅      🧠    👤  │
│  Home  Converse Tasks  Memory  Me  │
└─────────────────────────────────────┘
```
Personalized lines: "You have 3 reminders today, next at 10:00 AM." / "You met Kumar yesterday — review the follow-up?" / offline banner: "Your saved reminders still work; live AI is unavailable."

## 5.6 Converse Screen (primary live agent)

```text
┌─────────────────────────────────────┐
│  ← Back                  🔴 ⏹     │  recording badge if active
├─────────────────────────────────────┤
│         ╭───────────────╮           │
│         │   [ AVATAR ]  │           │  animates per state
│         │  🗣️ Speaking │           │
│         ╰───────────────╯           │
│         ◉ Listening...              │
├─────────────────────────────────────┤
│  Live Transcript (Tamil + English): │
│  ┌─────────────────────────────┐   │
│  │ You: "Remind me tomorrow    │   │
│  │      at 10 to call Kumar"   │   │
│  │ Nova: "Sure! I'll remind    │   │
│  │  you tomorrow at 10 AM."    │   │
│  └─────────────────────────────┘   │
│  [🔊 Captions ON] [📝 Full transcript]│
├─────────────────────────────────────┤
│  ╭─────────────────────────────╮   │
│  │   🎙 Speaking... (tap to stop)│  │
│  ╰─────────────────────────────╯   │
│  Quick actions:                     │
│  [Create Task][Set Reminder]        │
│  [Search Memory][Record Meeting]    │
│  [Translate]                        │
└─────────────────────────────────────┘
```
Controls: captions on/off, mute voice out, stop conversation, start explicit recording, report response, switch to text input. Accessibility: full screen-reader labels, always-available captions, OS font scale, optional haptics, color never the sole status signal.

**Avatar state → behavior map:**

| State | Visual | Trigger |
|---|---|---|
| Idle | Slow breathing loop | No active session |
| Wake detected | Quick perk-up animation | Wake word / tap-to-talk |
| Listening | Head tilt, eye contact | Mic open |
| Thinking | Hand-to-chin, soft glow pulse | Waiting on Claude/tool |
| Awaiting confirmation | Amber shield badge | Sensitive tool proposed |
| Executing | Progress ring | Tool running |
| Speaking | Lip-sync + subtitle bubble | TTS playing |
| Success | Green check + smile | Tool confirmed done |
| Warning/Error | Red badge, plain-text explanation | Failure / denial |
| Recording | Persistent red bar + timer | Explicit recording active |

## 5.7 Tool Confirmation Sheet (shown before every side-effecting action)

```text
Send WhatsApp message?
To: Kumar — +91 XXXXX XXXXX
Channel: Approved WhatsApp Business connection
Message:
"Hi Kumar, following up on our CRM and website
discussion. Shall I share the proposal?"

[Cancel]   [Edit message]   [Send]
```
Rules: recipient/target resolved before rendering; full human-readable payload shown; confirmation auto-expires after a short configurable window; no silent retries on external sends; every decision is audit-logged.

## 5.8 Tasks Screen

```text
Tasks (5 pending)
☐ Send quotation to Kumar     📅 Due Fri, Aug 29   🏷 CRM, Website
   [Complete] [Edit] [Delete]
☐ Prepare CRM proposal        📅 Due Mon, Sep 1    🏷 Business
☐ Call Ramesh about payment   📅 Due Today, 5 PM   🏷 Finance
✅ Call Kumar (completed)     📅 Yesterday
```
Sections: Today / Upcoming / Overdue / Waiting on others / Completed. Each task: title, owner, due time, status, source (voice/meeting/manual/integration), AI-confidence badge for proposed items, quick actions.

## 5.9 Reminder Composer & Detail

Fields: title, date/time + timezone, repeat rule, notification channel, linked task/contact/project, source/audit trail. Ambiguous phrasing ("tomorrow morning") must trigger a clarifying question unless a default time is configured.

```text
⏰ Call Kumar about CRM
   📅 Tomorrow, 10:00 AM   🔔 Push enabled
   [Dismiss] [Edit] [Delete]
```

## 5.10 Memory Screen

```text
Your Memories (42 total)          🔍  ➕
Filter: [All ▼][People][Projects][Preferences]

👤 PERSON — Kumar, CRM client
   Budget: ₹2,00,000
   Source: Client discussion, Aug 27 · Confidence: High
   [View evidence] [Edit] [Forget]

💼 PROJECT — Website + CRM development
   Deadline: Next month · Status: Proposal pending

⚙️ PREFERENCE — Prefers concise responses, Tamil+English

📅 EVENT — Team meeting, Tomorrow 3 PM, 5 attendees
```
Categories: Person, Company, Project, Preference, Goal, Event, Decision, Fact, Task, Reminder, Relationship, Conversation, Contact. Each card shows source evidence, confidence/importance, visibility (personal/shared/admin-governed), and edit/archive/delete/forget-all controls.

## 5.11 Recording Screen

```text
🔴 RECORDING            14:32
╭───────────────────╮
│  ~~~~^^^^~~~~     │   live waveform
╰───────────────────╯
[⏸ PAUSE]  [⏹ STOP]

Meeting: "Client Discussion"
Participants: 3 detected
Language: Tamil + English (Tanglish)
🎤 Speaker 1 (Tamil) 65%  🎤 Speaker 2 (English) 30%  🎤 Speaker 3 (Mixed) 5%
```
Non-negotiable: persistent red recording bar, timer, pause/stop, visible consent reminder ("Ensure everyone knows this conversation is being recorded"), upload/processing status after stop.

## 5.12 Meeting Summary Screen (post-recording)

```text
📅 Aug 27, 2026, 11:30 AM   ⏱ 30:15   👥 3 participants
🌐 Tamil + English

📋 Summary
Discussed CRM and website development for Kumar's
business. Budget agreed ₹2,00,000. Development starts
next month.

Decisions Made
✓ Start development next month
✓ Budget approved ₹2,00,000
✓ Use React Native for mobile

Action Items
☐ Send proposal (Due Friday) — You
☐ Prepare quotation (Due Friday) — You
☐ Schedule kickoff — Kumar

[Create Tasks] [Create Reminders]

Extracted Contacts
👤 Kumar | +91 98765 43210 — CRM client, budget ₹2L
[Save to Contacts]

[View complete transcript →]
```

## 5.13 Activity Center

Pending approvals, tool execution timeline, notifications, completed summaries, integration errors, security events, and data export/deletion request status — all in one feed.

## 5.14 Integrations Hub

```text
[Google Calendar]   Connected · scopes: read/write events
[Gmail]              Not connected
[WhatsApp Business]  Connected · last used 2h ago
[Contacts]           Connected
[CRM (Zoho/HubSpot)] Not connected
```
Each card shows connection state, exact granted scopes, last use, data types accessed, disconnect button, tool-permission policy link.

## 5.15 Privacy Center

Toggles for: save conversations / recordings / transcripts / summaries / memories, per-artifact auto-delete timing, export my data, delete conversation/recording/memory individually, delete all account data, consent history, active integrations & permissions.

```text
🔒 Save recordings          [ON]
📝 Save transcripts         [ON]
💭 Save memories            [ON]
🗑 Auto-delete recordings   [30 days]
🗑 Auto-delete transcripts  [7 days]
☁️ Cloud processing         [ON]
📱 Local processing         [OFF]
[Delete all my data]
```

## 5.16 Profile & Companion Settings

Identity/account, companion name/personality, voice + speed + tone, avatar/outfit/background/animation density, language policy, wake-word config, notification preferences, accessibility, developer diagnostics (beta only).

## 5.17 Organization Admin Console (V2)

Organizations/workspaces, users/groups/roles, SSO/SCIM, integration catalog + approvals, tool policy rules, retention/deletion configuration, memory visibility policy, audit logs, usage/cost/quotas, provider/model routing, system health/incidents/queues.

## 5.18 Floating Avatar Overlay (Android "companion mode")

Optional feature using Android's "Display over other apps" permission. Does **not** give NOVA visibility into other apps' content — it is purely a draggable presence.

```text
While using WhatsApp / Gmail / Chrome / Instagram:

                                  ┌─────────┐
                                  │  NOVA   │  ← draggable bubble
                                  │   ◉     │
                                  └─────────┘
Tap avatar →
┌─────────────────────────────────────┐
│  NOVA                         ✕     │
│  🎙 Listening…                      │
│  "What would you like to do?"       │
│  [Translate][Reminder][Task]        │
│  [Draft reply][Ask NOVA]            │
└─────────────────────────────────────┘
```
Rules: quiet/non-intrusive by default; never covers controls; never auto-expands over banking apps; never appears on lock screen unless deliberately enabled; never speaks sensitive content aloud.

## 5.19 Translation Composer ("Share to NOVA" flow)

Preferred pattern: user explicitly selects text in any app → Android Share Sheet → "Translate with NOVA" → NOVA opens this panel. This avoids invisible screen-reading entirely.

```text
← Translate with NOVA
From: Auto-detect ▼   To: Hindi ▼

Original text
┌─────────────────────────────────┐
│ நாளைக்கு quotation அனுப்புங்கள்  │
│ 🎙 Speak   📋 Paste              │
└─────────────────────────────────┘

Hindi translation
┌─────────────────────────────────┐
│ कृपया कल कोटेशन भेज दीजिए।       │
└─────────────────────────────────┘

[Copy] [Edit] [Speak] [Share]
[Use as WhatsApp draft]
```
Voice path: user says "NOVA, translate this into Hindi" → NOVA asks "Please dictate or paste the text" → same panel opens with voice-dictated source text.

## 5.20 Wake-Word Activation Flow

```text
User: "Hey Nova"
  → local on-device wake-word engine detects phrase
  → NOVA overlay/notification appears
  → Avatar: "Yes?"
  → user speaks request
  → STT + Claude reasoning
  → NOVA answers / creates reminder / opens translation panel
    or shows a confirmation sheet before any external action
```
Persistent (but compact) Android notification while the local listener is active:
```text
NOVA is ready for "Hey Nova"
Microphone listening is active locally
[Pause]   [Turn off]
```

## 5.21 Notification Companion Settings ("Smart Notification Assistant")

```text
[ON] Read selected notifications
Apps allowed:
  [✓] Gmail          [✓] Google Calendar
  [✓] WhatsApp Business   [ ] Personal WhatsApp
  [ ] Banking apps   [ ] OTP / authenticator apps

Rules:
  [✓] Ignore OTPs, passwords, bank alerts, auth messages
  [✓] Do not store raw notification text
  [✓] Summarize only high-priority work notifications
  [✓] Ask before reading notifications aloud
```

---

# 6. Design System

## 6.1 Direction
"Calm intelligence" — premium, approachable, professional enough for a business workspace. Dark-first theme for avatar immersion; light theme for accessibility/office use. Restrained indigo-violet glow, not neon overload. Glass surfaces only where contrast/performance hold up.

## 6.2 Color Tokens
```text
Brand primary   #6366F1
Brand secondary #8B5CF6
Accent          #22D3EE
Success         #10B981
Warning         #F59E0B
Danger          #EF4444
Dark background #0B1020
Dark surface    #151D33
Light background#F7F8FC
Text (dark)     #F8FAFC
Text (light)    #0F172A
```
Gradients: Primary `linear-gradient(135deg,#6366F1,#8B5CF6)`, Recording `linear-gradient(135deg,#EF4444,#F59E0B)`, Success `linear-gradient(135deg,#10B981,#3B82F6)`.

## 6.3 Typography
Inter for UI text; Noto Sans Tamil for reliable Tamil rendering; system font fallback on mobile.
```text
Display 32px · H1 28px · H2 24px · H3 20px
Body Large 18px · Body 16px · Body Small 14px · Caption 12px
Weights: Bold 700 (headings/CTAs) · SemiBold 600 (buttons) · Regular 400 · Light 300
```

## 6.4 Spacing & Radius
```text
Spacing: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 px
Radius:  8px small (buttons/inputs) · 16px medium (cards) · 24px large (modals) · 50% circle (avatar)
```

## 6.5 Motion
UI transitions 180–280ms; avatar state transitions 250–450ms; always respect the OS "Reduce Motion" setting.

## 6.6 Avatar Design Requirements

| Phase | Avatar tech | Capability |
|---|---|---|
| MVP | 2D rigged (Live2D-class) | Expression states, blink, head tilt, amplitude-based mouth motion |
| V1 | 2D+ | Viseme lip-sync, gesture library, cosmetic variants |
| V2 | 3D | GLTF/VRM via Three.js/Unity, separate renderer contract from agent runtime |

No generated real-person likeness as a default avatar.

```ts
export interface AvatarEngine {
  preload(avatar: AvatarAsset): Promise<void>;
  setState(state: AvatarState): void;
  setEmotion(emotion: Emotion, intensity: number): void;
  setAudioLevel(level: number): void;
  setViseme?(viseme: Viseme, durationMs: number): void;
  playGesture?(gesture: Gesture): void;
  dispose(): void;
}
```

---

# 7. AI Agent Architecture & Model Routing

## 7.1 Core Rule
Do not build one unrestricted "super agent." Build an orchestrated system with bounded responsibilities:

```text
Voice/UI Runtime
  → Session Orchestrator
      → Claude Reasoning Agent (Sonnet / Haiku, routed)
      → Context Assembler
      → Policy and Safety Engine
      → Tool Router
      → Memory Service
      → Workflow Engine
      → Event and Audit Service
```

## 7.2 Claude Sonnet vs Haiku — routing plan

| Workload | Model | Why |
|---|---|---|
| Main conversation / complex requests | **Sonnet** | Best reasoning, ambiguity handling, natural Tamil-English conversation |
| Multi-tool planning | **Sonnet** | Coordinates multiple tools, asks for missing details |
| Reminder/task extraction | **Haiku** (escalate to Sonnet if low confidence) | Cheap, fast, structured extraction |
| Recording summaries | **Haiku** for routine; **Sonnet** for high-stakes client meetings | Cost control vs accuracy where it matters |
| Memory extraction/classification | **Haiku** | High-volume background job with strict schemas |
| Notification triage | **Haiku** | Classify urgency, dedupe, route |
| Daily briefing | **Sonnet** | Connects calendar, tasks, follow-ups, priorities |
| Enterprise workflow planning | **Sonnet** | Policy-aware, multi-step reliability |
| Final spoken/text response | **Sonnet** by default | Personality, trustworthy clarification |

```text
New user request
    ↓
Low-risk, structured, clear?
    ├── Yes → Haiku (classify / extract / summarize / propose memory)
    └── No  → Sonnet (clarify / plan / retrieve memory / call tools / respond)
```
Rule of thumb: Haiku alone is never used for sensitive or ambiguous actions; Sonnet handles anything with real consequence.

## 7.3 Agent Roles

| Agent | Purpose |
|---|---|
| Realtime conversation agent | Fast dialogue, clarification, interruptible turn-taking, safe tool selection |
| Planner agent | Decomposes multi-step requests, builds an execution plan, flags approval needs — never executes directly |
| Tool execution runtime | Validates arguments, checks permissions/confirmation, executes registered tools, emits authoritative results |
| Memory agent | Extracts candidate memories, classifies sensitivity, scores confidence/importance, requests approval per policy |
| Meeting intelligence agent | Summarizes recordings, extracts speakers/decisions/tasks/deadlines/contacts with transcript evidence |
| Research agent | Searches approved sources, cites them, treats retrieved content as untrusted data (never as instructions) |

## 7.4 Claude Usage Boundaries

**Use Claude for:** intent extraction, structured tool-argument generation, planning, natural replies, meeting summaries, memory candidate extraction, explanation/synthesis.

**Never use Claude alone for:** authorization decisions, final date parsing without deterministic validation, sending messages, persisting records, resolving user/tenant identity, financial/medical/legal determinations.

## 7.5 Prompt Layering

```text
Layer 1: Immutable system safety & product policy
Layer 2: Tenant policy & permitted integrations
Layer 3: User persona & language preferences
Layer 4: Current session context
Layer 5: Retrieved memory & connected-tool results (UNTRUSTED DATA)
Layer 6: User message
```
Retrieved documents, emails, websites, and transcripts are always treated as data, never as instructions. Only registered tools are callable; every model-produced tool input is schema-validated; side-effecting tools require an approval token bound to the exact payload.

---

# 8. Voice & Language Architecture

## 8.1 Provider Strategy

| Capability | Primary | Fallback | Notes |
|---|---|---|---|
| Realtime conversation | ElevenLabs Conversational AI | Sarvam speech-to-speech | Benchmark latency + Tamil quality before locking in |
| English expressive TTS | ElevenLabs | Sarvam | Route by user choice/cost |
| Tamil/Tanglish STT+TTS | Sarvam | ElevenLabs / alternative | Indic-language benchmark gate is mandatory |
| Reasoning/tools | Claude API (server-side only) | — | Never called from the client |
| Wake word | On-device local engine | Push-to-talk | Android first |
| Recording transcription | Sarvam batch/streaming | Alternative qualified provider | Store timestamped source transcript |

## 8.2 Realtime Protocol
```text
Mobile app → backend issues short-lived session credential
Client connects to approved realtime voice service
Events stream to backend/session service
Backend calls Claude + registered tools as needed
TTS audio + avatar state events return to client
```
Permanent vendor API keys never exist on the client.

## 8.3 Multilingual Policy
Launch modes: English / Tamil / Auto (English+Tamil+Tanglish). Default: match the user's latest language/code-switching. Keep names, dates, currency, and confirmations unambiguous — show structured text for critical confirmations even during voice sessions.

Required evaluation cases: Tamil→English, English→Tamil, Tanglish in Latin script, Tamil script mixed with English product names, Indian names/phone numbers, currency/date/recurring-schedule parsing, and noisy office/vehicle/speakerphone audio.

---

# 9. Device Integration, Notifications & Proactive Voice

## 9.1 What NOVA can realistically integrate

### Personal productivity
| Capability | Automation level |
|---|---|
| Reminders / local+cloud alerts | Automatic after setup/confirmation |
| Tasks | Automatic for personal items if enabled |
| Calendar read | Automatic; writes require confirmation |
| Contacts lookup | Requires device permission |
| Meeting recording/transcription/summary | Explicit start, always visibly active |
| Memory | User-controlled, editable, deletable |
| Daily briefing | Opt-in automatic |
| Follow-up suggestions | Suggest only — never contacts anyone automatically |

### Communication
| Capability | Required safeguard |
|---|---|
| Email read/summarize | OAuth + mailbox scope |
| Email draft | User edits before send |
| Email send | Full recipient/subject/body shown for confirmation |
| WhatsApp Business draft/send | Approved Business API provider + confirmation |
| SMS | Android permission/policy-sensitive; deferred unless justified |
| Phone calls | Resolve contact, show number, confirm before dialing |
| Notification triage | Notification-listener access + user-defined filters |

## 9.2 Android device-control feasibility

| Feature | Feasibility | Plan |
|---|---|---|
| Push notifications | Full | Core MVP |
| Read app notifications | Notification Listener access | Opt-in beta, strict filters |
| Speak selected notifications | After notification access granted | "Driving/focus mode," user-configured |
| Open apps / deep links | Supported for compatible apps | V1 |
| Local reminders | Full | MVP |
| Calendar/contacts | Via permission/OAuth | V1 |
| Initiate a call | Platform API/intent | Show number, confirm |
| Send SMS | Restricted/policy-sensitive | Deferred |
| Control Wi-Fi/Bluetooth/settings | Partial, OS-version dependent | Deep-link to settings only |
| Read screen / control other apps | Sensitive accessibility path | **Excluded from consumer MVP** |
| Background wake word | Possible with careful architecture | Android-first, later phase |

## 9.3 Notification companion design ("Smart Notification Assistant")
Never build hidden monitoring. Ship it as an explicit, named, app-scoped feature (see Section 5.21 UI) with an OTP/bank-alert blocklist, no raw-text retention by default, and voice read-aloud only when the user opts in and confirms per session.

## 9.4 Proactive companion modes

| Mode | Behavior | Default |
|---|---|---|
| Silent | Push + in-app only | **Default** |
| Gentle | Speaks only when app is open or user allows | Opt-in |
| Driving | Reads urgent notifications aloud, accepts quick voice replies | Explicit opt-in |
| Focus | Suppresses non-urgent speech, summarizes later | User-configured |
| Morning briefing | "Good morning, two meetings and three follow-ups." | Opt-in |
| Reminder alert | Voice + notification at trigger time | Opt-in |
| Follow-up coach | Suggests a follow-up draft (never sends) | Opt-in |
| Meeting wrap-up | "Your summary is ready — two action items found." | Opt-in |

```text
Event occurs → check (opted-in? quiet hours? driving/focus mode? category allowed?
sensitive info? audio route available?) → notify → (if safe & enabled) speak minimal
alert → user responds → Sonnet handles conversation/next steps → any external action
still requires confirmation
```

## 9.5 Non-negotiable safeguards
Never read OTPs/bank alerts/passwords/auth codes aloud or store them; always show exact recipient + final content before any send; require a visible recording indicator with consent flow; let the user instantly disable proactive speech, notification access, memory, recordings, or any single integration; treat all external data (messages, mail, docs, sites) as untrusted data, never as instructions to the agent.

---

# 10. Tool & Integration Architecture

## 10.1 Permission Levels

| Level | Meaning | Examples | Default |
|---|---|---|---|
| L0 | Read-only | Search memory, view tasks, fetch calendar | May run without confirmation |
| L1 | Personal low-risk write | Create personal task/reminder | Configurable; confirm during beta |
| L2 | External communication | Send email/WhatsApp, shared CRM note | Always show full payload + confirm |
| L3 | Sensitive/consequential | Delete cloud data, change account setting, external file share | Explicit confirm + re-auth |
| L4 | Financial/high risk | Payment, transfer, contract execution | Out of scope for MVP |

## 10.2 Tool Contract
```ts
export interface RegisteredTool<TInput, TOutput> {
  id: string;
  name: string;
  version: string;
  tenantScope: 'personal' | 'organization';
  permissionLevel: 0 | 1 | 2 | 3 | 4;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  idempotencyRequired: boolean;
  confirmationRequired: boolean;
  execute(context: AuthorizedToolContext, input: TInput): Promise<ToolResult<TOutput>>;
}
```
Runtime requirements: JSON-schema validation; user/org resolved from verified session only (never client-supplied); idempotency keys on writes; timeout/retry/circuit-breaker; structured error codes; input/output log redaction; immutable audit event per call.

## 10.3 Integration Rollout

| Phase | Integrations |
|---|---|
| Launch | Internal tasks/reminders, local notifications, Google Calendar read/create, Outlook Calendar read/create, Contacts (device permission), Email draft (send only after confirmation) |
| V1 | Gmail/Outlook mail, Google Drive/OneDrive search, WhatsApp Business (approved provider), CRM (HubSpot/Zoho/Salesforce by demand) |
| V2 | Slack/Teams, Notion/Confluence, Jira/Linear/Asana, advanced CRM workflows, enterprise file stores, approved MCP servers |

## 10.4 Integration Authorization
OAuth tokens encrypted at rest with KMS envelope encryption; minimal scopes only; per-tenant consent + admin approval; disconnect revokes stored credentials and schedules vendor-side revocation; token refresh happens server-side only; health checks never expose user content in monitoring.

---

# 11. Memory System

## 11.1 Memory Types
```text
Working memory        current live turn/session
Conversation memory   recent messages/summaries
Episodic memory       meetings, calls, dated events
Semantic memory       stable facts and preferences
Task memory           commitments, tasks, reminders
Relationship memory   contacts and organizations
Enterprise memory     tenant-governed shared knowledge
```

## 11.2 Creation Pipeline
```text
Transcript/message → Claude candidate extraction → sensitivity classifier →
confidence/importance scoring → duplicate/conflict check →
policy decision (auto-save / propose / block) → scoped persistence →
embedding generation → audit event
```
Never auto-store: passwords/OTPs/tokens/keys, payment/ID documents (unless a dedicated secure vault exists), highly sensitive personal facts without explicit opt-in, or anything sourced only from untrusted external instructions.

## 11.3 Memory Record Schema
```ts
interface MemoryRecord {
  id: string;
  tenantId: string | null;
  userId: string;
  visibility: 'private' | 'shared' | 'admin-governed';
  category: 'person' | 'company' | 'project' | 'preference' | 'goal' | 'event' | 'decision' | 'fact';
  content: string;
  normalizedFacts: Record<string, unknown>;
  sourceType: 'conversation' | 'recording' | 'manual' | 'integration';
  sourceIds: string[];
  confidence: number;
  importance: number;
  sensitivity: 'normal' | 'sensitive' | 'restricted';
  status: 'proposed' | 'active' | 'archived' | 'deleted';
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## 11.4 Retrieval Policy
Hybrid retrieval: semantic vector search + keyword search + metadata filters + recency/importance/confidence scoring + optional reranking. Never send the whole memory store to Claude — retrieve only the smallest relevant evidence set, with source metadata attached.

---

# 12. Data Architecture

## 12.1 Repository Layout
```text
/apps          mobile, web, admin
/services      api, realtime-gateway, agent-orchestrator, workflow-engine,
               worker, notification-service, integration-service
/packages      auth, database, ai-core, tools, memory, voice, avatar,
               policy, observability, shared-types
/infrastructure docker, terraform, kubernetes, ci
/docs          adr, api, security, product, runbooks, evaluations
```

## 12.2 Primary Tables
```text
organizations, workspaces, users, user_profiles, roles, role_bindings,
sessions, devices, personas, avatars, avatar_assets,
conversations, conversation_messages, audio_recordings,
transcripts, transcript_segments, recording_summaries,
memories, memory_embeddings, tasks, reminders, notifications,
integrations, integration_connections, tool_definitions,
tool_executions, tool_approvals, consent_records, privacy_preferences,
retention_policies, audit_logs, usage_records, subscriptions,
feature_flags, provider_configs, incident_events
```

## 12.3 Storage Rules
PostgreSQL for structured metadata/entities; pgvector for embeddings near metadata (MVP); audio/large assets in S3-compatible object storage only (never DB blobs); tenant/user-scoped opaque object keys; checksums/encryption metadata/retention class/deletion status stored per object; soft delete provides a recovery window before hard deletion per policy.

---

# 13. Complete API Design

Base path: `/api/v1`

## 13.1 Authentication
```text
POST /auth/register
POST /auth/login
POST /auth/otp/request
POST /auth/otp/verify
POST /auth/refresh
POST /auth/logout
GET  /auth/session
```

## 13.2 Companion Configuration
```text
GET   /companion
PATCH /companion
GET   /avatar
PATCH /avatar
POST  /avatar/assets
GET   /persona
PATCH /persona
```

## 13.3 Conversation & Voice
```text
POST /voice/sessions
POST /voice/sessions/:id/refresh
POST /voice/sessions/:id/end
GET  /voice/config
GET  /conversations
POST /conversations
GET  /conversations/:id
DELETE /conversations/:id
POST /conversations/:id/messages
```

## 13.4 Recording
```text
POST /recordings
POST /recordings/:id/upload-url
POST /recordings/:id/complete
GET  /recordings/:id
GET  /recordings/:id/transcript
GET  /recordings/:id/summary
POST /recordings/:id/reprocess
DELETE /recordings/:id
```

## 13.5 Tasks & Reminders
```text
GET    /tasks
POST   /tasks
PATCH  /tasks/:id
DELETE /tasks/:id
GET    /reminders
POST   /reminders
PATCH  /reminders/:id
DELETE /reminders/:id
```

## 13.6 Memory
```text
GET    /memories
POST   /memories
POST   /memories/search
GET    /memories/:id
PATCH  /memories/:id
DELETE /memories/:id
POST   /memories/forget-all
```

## 13.7 Approvals & Activity
```text
GET  /approvals
GET  /approvals/:id
POST /approvals/:id/approve
POST /approvals/:id/reject
GET  /activity
GET  /tool-executions
```

## 13.8 Integrations
```text
GET    /integrations
POST   /integrations/:provider/connect
GET    /integrations/:provider/callback
DELETE /integrations/:connectionId
GET    /integrations/:connectionId/scopes
```

## 13.9 Translation
```text
POST /translate               { text, sourceLang?, targetLang }
POST /translate/from-share    { sharedText, sourceApp }
GET  /translate/history
```

## 13.10 Notifications / Device Companion
```text
GET   /device/notification-policy
PATCH /device/notification-policy
POST  /device/notifications/ingest      (local listener → backend, filtered client-side first)
GET   /device/wake-word/config
PATCH /device/wake-word/config
```

## 13.11 Privacy & Export
```text
GET  /privacy/preferences
PATCH /privacy/preferences
POST /privacy/export
GET  /privacy/export/:id
POST /privacy/deletion-request
GET  /privacy/deletion-request/:id
GET  /privacy/consents
```

## 13.12 API Conventions
OpenAPI 3.1 contract maintained in-repo; versioned endpoints with a deprecation policy; RFC 7807-style structured errors; `Idempotency-Key` required on all action-creating writes; cursor pagination; rate limits by user/tenant/IP/integration/cost-tier; every response carries a request ID; sensitive fields redacted in logs.

---

# 14. Realtime Event Contract

```ts
interface AppEvent<T> {
  id: string;
  type: string;
  occurredAt: string;
  requestId: string;
  sessionId?: string;
  conversationId?: string;
  tenantId?: string;
  payload: T;
}
```

```text
voice.session.started / voice.session.ended
voice.transcript.partial / voice.transcript.final
voice.user.interrupted
assistant.state.changed
assistant.audio.started / assistant.audio.ended
avatar.state.changed
recording.started / recording.paused / recording.completed
transcript.completed / summary.completed
memory.proposed / memory.created / memory.deleted
task.created / reminder.created / reminder.triggered
tool.requested / tool.approval.required / tool.approved / tool.rejected
tool.executed / tool.failed
integration.connected / integration.error
translation.completed
notification.triaged
privacy.deletion.requested / privacy.deletion.completed
```

---

# 15. Security, Privacy & Enterprise Governance

## 15.1 Identity & Access
OAuth/OIDC-compatible auth; MFA for account/admin access; RBAC (owner, admin, manager, member, auditor, support-limited); SSO/SAML + SCIM in V2; tenant isolation enforced at service and DB row-level; never trust a client-supplied `user_id`/`organization_id`.

## 15.2 Secrets & Encryption
TLS everywhere; envelope-encrypted tokens/integration data via KMS; secrets manager for provider credentials; short-lived client credentials for realtime voice sessions; key rotation + CI secret scanning.

## 15.3 AI Security
Treat all tool output/retrieved content as untrusted; prompt-injection detection and content isolation; allowlisted tool registry only (no arbitrary HTTP/shell tool); schema validation + policy enforcement + approval gate before every write; per-tool SSRF defense and outbound allowlists; content moderation appropriate to the product; human escalation path for high-risk/ambiguous enterprise actions.

## 15.4 Recording & Consent
Recording is explicit, off by default, and its active state is always visible; jurisdiction-aware consent notices before each market launch; participants must have a clear chance to know recording is active; consent records + provenance are stored.

## 15.5 India Privacy Baseline
Purpose-specific, clear, withdrawable consent; full access/correction/update/deletion workflows; purpose-bound retention; deletion propagates to downstream processors/storage unless legal retention applies. **This is an engineering plan, not legal advice** — retain privacy counsel before launch, especially for recording, employee monitoring, voice biometrics, and cross-border data transfer.

## 15.6 Audit & Evidence
Every audit event captures: actor, user/tenant, request ID, source device, agent decision, retrieved source IDs, proposed tool input, approval decision, actual tool input, external response status, result classification. Raw sensitive transcript/audio is never written into application logs.

---

# 16. Reliability, Performance & Observability

## 16.1 Targets

| Metric | MVP target | Production target |
|---|---:|---:|
| First audible response | < 1.8s | < 1.5s p50 |
| User interruption stop | < 400ms perceived | < 300ms perceived |
| UI state update | < 150ms | < 100ms |
| Reminder schedule ack | < 3s | < 2s |
| API availability | 99.5% (beta) | 99.9% |
| RPO | 24h (beta) | 1h |
| RTO | 8h (beta) | 4h |

## 16.2 Background Workers
```text
transcription, speaker diarization, summary extraction, memory extraction,
embedding generation, notification delivery, reminder scheduling,
integration sync, usage metering, retention deletion, export generation
```
Redis/BullMQ (or equivalent) durable queue; exponential-backoff retries; dead-letter queues; idempotent consumers; job trace IDs with user-visible processing states.

## 16.3 Observability
OpenTelemetry traces/metrics/structured logs + error tracking + cost/usage events. Key dashboards: realtime session count, first-audio latency, STT/TTS latency+error, Claude latency/token/cost, tool success/failure by integration, approval completion/drop-off, queue depth/age, memory extraction outcomes, recording pipeline completion, mobile crash-free sessions, security/policy denials.

---

# 17. Quality & Evaluation

## 17.1 Test Pyramid
Unit (date parsing, policy engine, schemas, memory ranking, redaction) → contract tests (provider adapters/integration clients) → integration tests (conversation→policy→tool→persistence) → E2E mobile (mic, network transitions, Bluetooth, lock screen, background/foreground) → load tests (API/queues/gateway/tool execution) → security tests (auth, tenant isolation, injection, SSRF, token exposure, replay).

## 17.2 AI Evaluation Suite (version-controlled datasets)
```text
200 English intent examples · 200 Tamil intent examples · 200 Tanglish intent examples
150 reminder/time examples · 150 task extraction examples
100 memory retrieval questions · 100 tool approval scenarios
100 prompt-injection / malicious tool-output cases
100 meeting summary + action extraction cases
100 interruption/repair cases
```
Measure: intent accuracy, slot/argument accuracy, date/time resolution accuracy, Tamil/Tanglish transcription quality, memory precision/recall, tool-call validity rate, unauthorized-action rate (target zero), hallucinated-success rate (target zero), summary factuality against transcript.

## 17.3 Release Gates
No feature ships to production unless: a security threat model exists; API + integration contract tests pass; AI-eval regression is within threshold; logging/redaction reviewed; a rollback plan exists; a feature flag exists for risky capabilities; UX confirms consent/approval and error states.

---

# 18. Realistic "Zero Human Interface" Development Model

You asked for development to be handled almost entirely by Claude AI agents with no human interface in the loop. Here is the honest, workable version of that goal, using Claude Sonnet/Haiku as the coding workforce with the absolute minimum of unavoidable human touchpoints.

## 18.1 What can genuinely run with zero human authoring
Claude coding agents can generate essentially all of: service code, database migrations, unit/integration/contract tests, UI scaffolding for every screen in Section 5, OpenAPI/event contracts, CI configuration, Terraform/Kubernetes manifests, documentation, runbooks, and even draft security threat models — end to end, with no human writing code.

## 18.2 What cannot be automated away (and why)
These are not "extra human steps for caution" — they are hard external requirements you cannot delegate to any AI agent, because they require a legally accountable human/business entity:

- Owning and paying for production infrastructure, domain, app-store developer accounts, and vendor billing (Claude/Anthropic API key, ElevenLabs, Sarvam, AWS/GCP, Play Console).
- Clicking "Publish" on the Play Store / App Store — Google and Apple require a verified human/business account holder.
- Signing DPAs, privacy policy, and terms of service — these are legal instruments, not code.
- Approving the first production deployment and any irreversible external action (e.g., the first real WhatsApp/email send to a real customer).
- Reviewing real Tamil/Tanglish voice quality on physical devices — this needs a human ear, not a benchmark score alone.

Everything else — architecture, code, tests, UI, docs, CI — can be 95%+ AI-generated with the human only clicking "approve" at defined checkpoints, not writing anything.

## 18.3 Claude Coding Agent Roles

| Agent | Responsibility | Cannot do |
|---|---|---|
| Product Architect | ADRs, module boundaries, OpenAPI/event contracts | Merge or deploy to production |
| Backend Builder | Services, migrations, tests, adapters | Access real production secrets |
| Mobile Builder | React Native screens, state, accessibility tests | Publish app builds without approval |
| Avatar Builder | Renderer, state machine, asset integration | Use unlicensed assets |
| QA Agent | Test plans, Playwright/Detox tests, regression reports | Override failing gates |
| Security Agent | Threat models, SAST findings, policy tests | Approve a release alone |
| DevOps Agent | IaC, CI/CD, monitoring config | Apply production infra changes unsupervised |
| Documentation Agent | Runbooks, API docs, release notes | Alter implementation contracts silently |

## 18.4 Git Workflow (fully agent-operated except the merge button)
```text
main                 protected; production-ready only
release/*            release stabilization
feature/LEA-###-*    isolated feature branch
ai/*                 agent-created branches
```
Automated required checks before merge: type checking, linting, unit+integration tests, security scanning, dependency/license scanning, OpenAPI validation, migration validation, AI-eval regression. A human/code-owner click is required only for policy, infrastructure, auth, payments, deletion, and integration-write changes — everything else can auto-merge on green CI.

## 18.5 Agent Task Template (every ticket, AI-authored)
```text
Ticket ID · Goal · User story · Non-goals · Architecture constraints
Files/modules allowed to change · API/events affected · Database changes
Security/privacy requirements · Acceptance criteria · Test cases
Observability requirements · Feature flag/rollback strategy · Definition of done
```

## 18.6 Example Epic Sequence (AI-executable, in order)
```text
LEA-001 Monorepo and CI foundation
LEA-002 Authentication and tenant model
LEA-003 Design system and app shell
LEA-004 Avatar runtime and state event contract
LEA-005 Conversation and text-agent vertical slice
LEA-006 Claude tool orchestration and policy engine
LEA-007 Tasks and reminders
LEA-008 Realtime voice adapter
LEA-009 Tamil/Tanglish speech benchmark and adapter
LEA-010 Recording and transcription pipeline
LEA-011 Summaries, action extraction, and memory
LEA-012 Privacy center and deletion workflow
LEA-013 Integrations framework and calendar
LEA-014 Notification companion + wake-word + overlay
LEA-015 Translation composer + Share-to-NOVA
LEA-016 Admin console, audit, observability
LEA-017 Security hardening and production readiness
```

---

# 19. Phased Delivery Plan (Week-by-Week)

| Phase | Weeks | Deliverables | Exit criteria |
|---|---|---|---|
| **A — Foundation** | 1–3 | Monorepo, Docker stack, CI/CD, Postgres/Redis/object storage, auth/users/orgs/sessions, OpenAPI+event contracts, design tokens, RN shell, Claude adapter + mock provider | New agent can bootstrap locally; authenticated API round-trip works with trace ID visible end-to-end |
| **B — Companion Vertical Slice** | 4–7 | Home/Converse/Tasks screens, avatar state engine, text conversation via Claude, tool policy engine, create-task/reminder tools, confirmation UI, conversation persistence | User types/speaks, sees avatar response, creates a confirmed reminder visible in Tasks |
| **C — Voice & Multilingual Beta** | 8–12 | Push-to-talk realtime voice, captions/interruption/TTS, Sarvam+ElevenLabs benchmark, Tamil/Tanglish policy+tests, voice analytics | Reliable EN/TA/Tanglish demo on target Android devices with a latency/quality dashboard |
| **D — Recording & Intelligence** | 13–17 | Explicit recording flow, upload/processing pipeline, transcripts/diarization/summaries, proposed tasks/reminders/memories with evidence links | A 30-minute recording produces a reviewable summary + transcript + proposed actions |
| **E — Personal Productivity Integrations** | 18–22 | Calendar, contacts, email drafting, activity center, daily briefing, export/deletion | User connects calendar, queries events, creates approved entries, revokes access |
| **E2 — Device Companion** | 20–24 | Notification listener + filters, local wake word, floating overlay, translation composer/Share-to-NOVA | "Hey Nova" works backgrounded; Share-to-NOVA translation round-trips correctly |
| **F — Closed Beta** | 23–26 | Feature flags, crash/error reporting, usage quotas, support workflow, security review scope, feedback loops | 25–100 invited users run core workflows with monitoring/support/rollback in place |
| **G — Public MVP Launch** | 27–30 | Android production release, pricing/billing, help center, privacy policy/terms, status page/runbooks | Activation/retention/cost/support metrics established |
| **H — Enterprise Pilot** | 31–40 | Workspaces/roles/admin console, audit reports, retention controls, CRM+approved comms, SSO proof-of-concept, DPA materials | 1–3 design partners running bounded monitored business workflows |

---

# 20. Launch & Go-To-Market Plan

**Positioning:** "Your Tamil-English AI companion for conversations, follow-ups, meetings, and daily work."

**Initial audience** (matches your existing network): Tamil Nadu entrepreneurs, sales/service-business owners, digital marketing professionals, consultants/agency teams, BNI-network contacts, students/professionals preferring Tamil-English interaction.

**Beta program:** recruit 25–100 high-intent users who handle meetings/reminders/client follow-up daily. Track: activation (onboarding + first conversation + first reminder within 24h), weekly retention, voice-session completion, Tamil/Tanglish satisfaction, meeting-summary acceptance, proposed-task approval rate, tool-confirmation completion, memory correction/deletion rate, cost per active user, support tickets per 100 sessions.

**Launch assets:** privacy-first landing page, 45–60s Tamil-English demo video, app-store screenshots (avatar home, voice conversation, recording, meeting summary, privacy center), product tour, terms/privacy/recording-notice/acceptable-use policy, support+incident contact flow.

**Pricing hypothesis** (do not fix prices before real cost data):

| Tier | Audience | Entitlements |
|---|---|---|
| Free | Trial/discovery | Limited voice minutes, reminders, short memory window |
| Pro | Individual power user | Higher voice/recording limits, integrations, retained memories |
| Business | Small team | Workspace, shared approved knowledge, admin controls |
| Enterprise | Larger org | SSO, retention, audit, custom policy, support SLA |

Hard limits must be enforced server-side by entitlements, never by prompting the model to "behave" within a limit.

---

# 21. Requirements From Your Side

Everything else in this document can be produced by AI agents. These items require you (Leadup Technologies) specifically, because they involve money, legal identity, or subjective judgment that no agent can substitute for.

## 21.1 Accounts & API keys you must create and fund

| Item | Why it's needed | Approx. effort |
|---|---|---|
| Anthropic Claude API account + billing | Core reasoning (Sonnet + Haiku) | 15 min setup, ongoing usage cost |
| ElevenLabs account + API key | English realtime voice/TTS | 15 min setup, usage-based cost |
| Sarvam AI account + API key | Tamil/Tanglish STT+TTS | 15 min setup, usage-based cost |
| Cloud provider account (AWS or GCP) + billing | Hosting backend, database, object storage | 30 min setup, ongoing infra cost |
| Google Play Console developer account | Publishing the Android app | One-time registration fee + identity verification |
| Apple Developer account (when iOS starts) | Publishing on App Store | Annual fee + identity verification |
| Domain name + DNS | App/landing page/API hostnames | ~₹1,000–2,000/year |
| WhatsApp Business API provider (e.g., an approved BSP) | Sending approved WhatsApp messages | Business verification required |
| Payment gateway account (Razorpay/Stripe) | Subscriptions once pricing goes live | KYC/business documents |

## 21.2 Business & legal decisions only you can make

- Final product name/brand (NOVA is a placeholder — confirm or change).
- Target price points for Free/Pro/Business/Enterprise tiers once real cost data exists.
- Which integrations matter most to your own client base first (Calendar? WhatsApp? Email?) — this determines Phase E ordering.
- Privacy policy, terms of service, and recording-consent notice — draft with a lawyer familiar with India's DPDP framework; this cannot be AI-generated boilerplate for a product that records conversations.
- Data retention defaults (how long recordings/transcripts/memories are kept before auto-deletion).

## 21.3 Assets you need to supply or commission

- Avatar character design direction (art style, gender presentation, outfit, personality) — or approve AI-generated concepts.
- Brand logo, color confirmation (or approve the design tokens in Section 6.2), app icon.
- Sample Tamil/Tanglish audio clips from real conversations (with consent) to benchmark Sarvam vs. ElevenLabs before locking in a voice vendor.
- A short list of 25–50 beta testers from your BNI network / existing clients for the closed beta in Phase F.

## 21.4 Judgment calls that need a human sign-off, not an agent guess

- Approving the first production deployment and the first real external message sent to a real customer (per Section 18.2).
- Reviewing Tamil/Tanglish voice quality on physical devices before wider rollout — an agent's benchmark score is not a substitute for a native speaker listening to it.
- Approving any change to what NOVA is allowed to do autonomously (permission levels in Section 10.1) — this is a trust decision about your own product, not a technical one.

## 21.5 Ongoing costs to budget for (rough categories, confirm exact numbers with each vendor before committing)
Claude API usage (tokens per session), ElevenLabs/Sarvam voice usage (minutes/characters), cloud hosting (compute + database + storage), object storage for recordings, WhatsApp Business messaging fees, Play Console/Apple Developer annual fees, and payment gateway transaction fees once monetized.

---

# 22. Metrics & Unit Economics

## 22.1 Product Metrics
```text
DAU/WAU/MAU · activation rate · D1/D7/D30 retention
voice minutes per active user · tasks/reminders created per active user
meeting recordings completed · summary acceptance rate
memory retrieval success · approval completion rate
integration connection rate · NPS/CSAT
```

## 22.2 AI & Cost Metrics
```text
Claude input/output tokens per session · Claude cost per active user
STT minutes+cost · TTS characters/minutes+cost · realtime voice cost
storage GB+retention cost · embedding volume/cost
tool execution cost by integration · revenue margin by plan
```

## 22.3 Quality Guardrails (hard zero-tolerance targets)
```text
hallucinated action-success rate = 0
unauthorized tool execution rate = 0
sensitive memory auto-save incidents = 0
cross-tenant data exposure = 0
recording visibility failure = 0
critical vulnerability SLA met
```

---

# 23. Key Risks & Decisions

| Risk | Why it matters | Mitigation |
|---|---|---|
| Tamil/Tanglish quality | Core differentiator fails if recognition is unreliable | Benchmark Sarvam + alternatives on real local datasets before vendor lock-in |
| Realtime voice cost | Voice sessions can create high variable cost | Meter usage, route models, cap idle sessions, enforce plan quotas |
| iOS hotword assumptions | Platform restrictions can invalidate roadmap claims | Treat iOS as push-to-talk/Shortcuts initially; validate before promising more |
| Prompt injection | Connected data can try to manipulate the agent | Untrusted-data boundaries, policy engine, tool allowlists, confirmations |
| Memory privacy | A companion stores sensitive personal context | Consent, redaction, proposal/review flow, granular deletion |
| AI-only delivery | Autonomous code changes can introduce vulnerabilities | Protected branches, CI gates, human approval only on critical paths (Section 18) |
| Avatar scope creep | 3D realism can delay the core product | Ship performant 2D avatar first; evolve after retention is proven |
| Integration complexity | OAuth/rate-limits/security reviews multiply fast | Launch with internal tasks/reminders + calendar before messaging/CRM |
| Notification-listener sensitivity | Broad access can alarm users/reviewers | Explicit named feature, opt-in, app-level allowlist, OTP/bank blocklist |

---

# 24. Definition of Done — Public MVP

- [ ] User can securely register, log in, and recover account access.
- [ ] User can configure NOVA's name, personality, voice, language, and starter avatar.
- [ ] User can type and push-to-talk with the companion.
- [ ] Avatar reliably represents listening/thinking/speaking/success/warning/offline states.
- [ ] User can interrupt a spoken answer.
- [ ] English, Tamil, and Tanglish are explicitly evaluated on real devices.
- [ ] User can create, edit, complete, and delete tasks/reminders.
- [ ] The assistant never claims tool success without authoritative confirmation.
- [ ] Side-effecting tools show exact targets/payloads before confirmation.
- [ ] User can explicitly record, see a persistent recording indicator, and stop recording.
- [ ] User receives transcript, summary, decisions, and proposed tasks from recordings.
- [ ] User can view, correct, delete, and disable memories.
- [ ] Provider API keys are absent from all client code.
- [ ] Full data export/deletion flow is implemented and tested.
- [ ] Audit logs, cost/usage, health dashboards, and error tracking are live.
- [ ] Automated tests and AI evaluations pass release thresholds.
- [ ] Incident runbooks and support paths exist.

---

# 25. Immediate Next Actions

1. Create the accounts and API keys listed in Section 21.1 — nothing else can start without these.
2. Stand up the monorepo and architecture decision records (Claude agents can do this once you give the go-ahead).
3. Build the text-agent + avatar + reminder vertical slice (Phase B) before any live voice or device-integration work.
4. Collect a real, consented Tamil/Tanglish voice sample set from your own client calls to benchmark Sarvam vs. ElevenLabs.
5. Run the provider benchmark: ElevenLabs realtime voice, Sarvam STT/TTS, Claude tool accuracy, cost, latency, failure behavior.
6. Define the tool policy/approval engine (Section 10) before connecting any external communication or CRM tool.
7. Draft the privacy center and deletion design (Section 15.5) before enabling persistent recordings or memory — get legal review in parallel.
8. Recruit 25–50 Tamil-English beta users from your BNI network once the vertical slice (Phase B) is measurable and monitored.

---

## Document Provenance

This master document consolidates every planning round from this thread: the original Multilingual Realtime AI Voice Companion SRD, the ElevenLabs/Sarvam/Claude replan, the "Jarvis-style avatar company" enterprise blueprint, the full UI wireframe set, the Claude Sonnet/Haiku model-routing plan, the device/notification-monitoring integration plan, the floating-avatar-overlay and translation-companion plan, and the voice wake-word plan — reorganized into one buildable reference with an added Requirements-From-Your-Side section. Vendor capabilities, pricing, supported languages, and SDK details should be reconfirmed against official Anthropic, ElevenLabs, and Sarvam documentation at the start of each implementation phase before committing to a production dependency.
