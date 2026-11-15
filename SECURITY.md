# Security policy

Kendra handles health-adjacent personal information, so security is part of the design, not an add-on.

## Reporting a vulnerability

Please open a private security advisory on this repository ("Security" → "Report a vulnerability") rather than a public issue. Include steps to reproduce. You will get a reply within 72 hours.

## Threat model summary

| Threat | Mitigation | Code |
|---|---|---|
| Guessing a PIN or passcode | scrypt hashes, constant-time comparison, per-IP rate limit, per-circle lockout (8 failures → 15 min), timing-equalised unknown codes | `src/security/passcode.js`, `src/http/routes/auth.js` |
| Stolen or stale session | HMAC-signed `httpOnly` / `Secure` / `SameSite=Strict` cookie; membership and token version re-checked on every request; removal, passcode rotation and PIN reset revoke sessions | `src/security/session.js`, `src/http/middleware.js` |
| Forgotten PIN abused for takeover | Code emailed only to the elder's address on file; identical response for unknown circles; scrypt-hashed, 15-minute expiry, 5 attempts, single use | `src/http/routes/auth.js` |
| Cross-site request forgery | `SameSite=Strict` plus a required `X-Requested-With` header on state-changing calls | `src/http/middleware.js` |
| Cross-site scripting | Strict CSP (`script-src 'self'`, no inline script); UI renders user text via `textContent`; email HTML escaped | `src/app.js`, `public/js/dom.js`, `src/services/mailer.js` |
| Mass assignment / malformed input | Strict Zod schemas reject unknown fields; body size limits | `src/http/schemas.js` |
| Privilege escalation between roles | Central policy `can(member, action, circle)`; elder-only management actions | `src/domain/policy.js` |
| Emergency link leakage | 256-bit secrets, SHA-256 hash-only storage, expiry, revocation, view counting, limited fields, `noindex` | `src/domain/emergency.js` |
| Prompt injection via user text or images | User content passed as JSON data; model output schema-validated; AI never writes schedules or facts | `src/services/ai.js`, `src/domain/companion.js` |
| Secret leakage | Secrets only via environment variables; `.env` git-ignored; production refuses a weak `SESSION_SECRET` | `src/config.js`, `.gitignore` |
| Vulnerable dependencies | 6 runtime dependencies; `npm audit` in CI | `.github/workflows/ci.yml` |

## Data handling

- Demo circles are fictional, kept in memory only, and deleted after 24 hours.
- Dose logs are pruned after 90 days and notifications after 30 days.
- Emails are sent BCC so members never see each other's addresses.
