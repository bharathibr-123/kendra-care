# Kendra API reference

Base URL: your deployment (for example `https://kendra-care.onrender.com`). All bodies are JSON.

**Authentication.** Signing in sets an `httpOnly`, `SameSite=Strict` session cookie. Every state-changing `/api` request must also send the header `X-Requested-With: kendra` (CSRF defence). Every request body is validated with a strict schema, so unknown fields return `400`.

**Errors.** Errors use this shape: `{ "error": "message", "fields": [{ "path": "elderPin", "message": "PIN must be exactly 6 digits" }] }`. Status codes: `400` validation, `401` not signed in, `403` not allowed for your role, `404` not found, `409` conflict, `413` too large, `429` rate limited.

**Roles.** The access-rule column uses these roles:
- **E** = elder
- **C** = caretaker
- **F** = family
- **All** = any member of the circle

## Access and sessions

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/circles` | public | Create a care circle: `{ elderName, elderEmail?, elderPin (6 digits), sharePasscode (8+ chars), timezone? }` |
| POST | `/api/session` | public | Elder: `{ role:"elder", code, pin }`. Others: `{ role:"caretaker"\|"family", code, passcode, name, email? }` |
| DELETE | `/api/session` | All | Sign out |
| POST | `/api/session/recover` | public | `{ code }`. Emails a 6-digit code to the elder's address on file. Always returns 202 with the same message |
| POST | `/api/session/recover/verify` | public | `{ code, otp, newPin }`. Resets the PIN, revokes other elder sessions, signs in |
| POST | `/api/demo` | public | Create a fresh demo circle and sign in: `{ role? }` |
| POST | `/api/demo/role` | demo only | Switch the demo viewpoint: `{ role }` |
| POST | `/api/circle/passcode` | E | Rotate the shared passcode (signs out everyone except the elder) |
| DELETE | `/api/members/:id` | E | Remove a member (their session is revoked immediately) |
| PUT | `/api/members/:id/responder` | E | `{ responder: "primary"\|"backup"\|"none" }` |
| PUT | `/api/me/notifications` | All | `{ notify, email? }` |
| PUT | `/api/settings` | E | `{ requireApproval?, upcomingLeadMin?, followupMin?, escalatePrimaryMin?, escalateBackupMin?, timezone? }`. The timings must increase in that order. |

## Dashboard

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/dashboard` | All | One round-trip state: today's and tomorrow's doses, medications, appointments, proposals, 7- and 30-day adherence, routine drift, care slots and handover snapshot, tasks, notes, handovers, emergency card, notifications and the activity log |

## Medications and appointments (elder consent)

Requests from caretakers and family return **202** with a `proposal` when `requireApproval` is on. Otherwise, and always for the elder, the change applies immediately and the response is **201/200**.

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/medications` | All | `{ name, dosage?, instructions?, times[], days[]?, startDate?, endDate?, stock?, refillAt? }` |
| PUT | `/api/medications/:id` | All | Partial update, including `{ active: false }` to pause |
| DELETE | `/api/medications/:id` | All | Remove |
| POST | `/api/appointments` | All | `{ doctor, specialty?, location?, date, time, notes? }` |
| PUT | `/api/appointments/:id` | All | Partial update, including `{ status: "done"\|"cancelled" }` |
| DELETE | `/api/appointments/:id` | All | Remove |
| POST | `/api/proposals/:id/decision` | E | `{ approve: true\|false }` |

## Doses and care continuity

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/doses` | All | `{ medId, date, time, status: "taken"\|"missed", note? }`. This is an explicit confirmation or report; stock is kept in sync |
| DELETE | `/api/doses/:key` | All | Undo a record (`medId@YYYY-MM-DD@HH:MM`) |
| POST | `/api/alerts/acknowledge` | C, F | `{ slot: "YYYY-MM-DDTHH:MM", note? }`. Stops escalation to the backup contact |
| POST | `/api/tasks` | All | `{ title, dueDate?, assigneeId? }` |
| PUT | `/api/tasks/:id` | All | `{ status?: "open"\|"done", assigneeId? }`. Complete or transfer a task |
| POST | `/api/notes` | All | `{ text }` |
| POST | `/api/handovers` | All | `{ toId?, note? }`. Stores a live snapshot of today |
| POST | `/api/handovers/:id/acknowledge` | addressee | Acknowledge a handover (not by its author) |

## AI features

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/ai/companion` | All | `{ text }` → `{ answer, language, intent, source: "records"\|"safety"\|"general", tool, classifiedBy }` |
| GET | `/api/ai/daily-brief` | All | `{ facts, brief }`. Facts are computed from records; `brief.source` is `gemini` or `rules` |
| GET | `/api/ai/brief` | All | Weekly brief grounded in 7-day adherence |
| POST | `/api/ai/brief/send` | E, C | `{ period: "daily"\|"weekly" }`. Emails the circle |
| POST | `/api/ai/prescription` | All | `{ mimeType: "image/jpeg"\|"image/png"\|"image/webp", data: base64 }` → draft medications (nothing is saved) |

## Emergency card

| Method | Path | Who | Purpose |
|---|---|---|---|
| PUT | `/api/emergency` | E | `{ contacts[≤5]?, allergies?, conditions?, bloodGroup?, notes? }` |
| POST | `/api/emergency/shares` | E | `{ hours: 1–72 }` → `{ share, url, qrSvg }` |
| DELETE | `/api/emergency/shares/:id` | E | Revoke a link |
| GET | `/api/public/emergency/:token` | public, rate-limited | Limited card for a valid, unexpired, unrevoked token |
| GET | `/e/:token` | public | Mobile page that renders the card |

## Operations

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/healthz` | public | `{ status, store, ai, mail }` |
| POST | `/api/cron/tick` | `X-Cron-Secret` header | Runs the reminder and escalation engine (for hosts that sleep when idle) |
