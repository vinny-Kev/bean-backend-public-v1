# Identity, onboarding and organization management: backend reference

Status: implemented in the backend; the frontend is built separately (`bean-frontend/docs/identity-frontend-contract.md`). This file is the **authoritative backend contract** and also records the security model, configuration and deployment steps. The generated, request-by-request reference is `docs/api/API_REFERENCE.md`.

## 1. What changed for clients (differences from the frontend's proposed contract)

| Topic | Backend behavior |
|---|---|
| Registration body | `{ fullName, username, email, password }`. **`fullName` is required** (2-100 characters). Answer: always `202 { status: "verification_sent", codeLength: 6, retryAfterSeconds: 60 }`. Only `USERNAME_TAKEN` (409) is explicit. |
| Verification | `POST /auth/verify-email { email, code }` -> `200`, no session. `POST /auth/verify-email/resend { email }` -> always `202`. |
| Sign-in | `200 { user }`, or `202 { challenge: "email_otp", challengeId, codeLength, retryAfterSeconds, expiresInMinutes }` (no session yet), or `403 EMAIL_NOT_VERIFIED`. `POST /auth/login/verify { challengeId, code }` -> `200 { user }`. |
| `/auth/me` | adds `fullName` and `emailVerified`. |
| Onboarding | `GET /onboarding` -> `{ data: { step: "organization"\|"done", organizations, pendingInvitations, canCreateOrganization } }`. |
| Invitations (admin) | `POST/GET /tenants/:id/invitations`, `POST .../:invitationId/resend`, `DELETE .../:invitationId`. |
| Invitations (invitee) | `POST /invitations/preview { token }` (public), `GET /invitations/mine`, `POST /invitations/accept { token }`, `POST /invitations/:id/accept`. Tokens travel in the body; links carry them in the URL fragment `#token=`. |
| Ownership transfer | **Two steps**, not one: `POST /tenants/:id/ownership-transfer/request { newOwnerUserId }` (emails the owner a code) then `POST .../confirm { code }`. |
| Organization creation | `POST /tenants` accepts an `Idempotency-Key` header (8-100 chars). |
| Error codes | `OTP_INVALID`, `OTP_EXPIRED`, `OTP_ALREADY_USED`, `OTP_LOCKED`, `OTP_RATE_LIMITED` (with `Retry-After` and `retryAfterSeconds`), `RESET_TOKEN_INVALID`, `INVALID_PASSWORD`, `CHALLENGE_NOT_FOUND`, `EMAIL_NOT_VERIFIED`, `USERNAME_TAKEN`, `EMAIL_UNAVAILABLE`, `INVALID_INVITATION`, `INVITATION_EXPIRED`, `INVITATION_EMAIL_MISMATCH`, `INVITATION_NO_LONGER_VALID`, `INVITATION_NOT_FOUND`, `INVITATION_NOT_PENDING`, `INVITATION_LIMIT`, `RESEND_COOLDOWN`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`, `INVALID_TRANSFER`. All use `{ error: { code, message, requestId } }`. |
| Email change | `POST /auth/email-change/request { newEmail, currentPassword }` (session), `POST /auth/email-change/confirm { code }`. |
| Password reset | `POST /auth/password/forgot { email }` (always 202), `POST /auth/password/reset { token, newPassword }` (`200`). The emailed link is `${APP_BASE_URL}/reset-password#token=...`. |
| Ticketing | Non-members now get 404 (previously 403); see the QA report. |

CSRF is unchanged: no token; unsafe requests need an allowed `Origin`.

## 2. Security model

- **One-time codes** (`auth_challenges`): 6 digits from `crypto.randomInt`, valid 10 minutes, 5 attempts, single use. Only `HMAC-SHA256(pepper, purpose|challenge id|code)` is stored; the purpose is inside the hash and the row is bound to the user and (for email codes) the address, so a code for one purpose, user or address can never satisfy another. A new code supersedes the live one for the same user and purpose; resend cooldown 60 s and at most 5 codes per hour per user and purpose; wrong attempts are counted in the database before the answer is returned. Codes are never logged, audited or returned.
- **Reset and invitation tokens**: 256-bit random, stored as HMAC only, single use, reset 60 minutes, invitation 7 days. Carried in the URL fragment so they never reach servers, proxies or `Referer`.
- **Registration**: the account is created unverified and cannot sign in. The response never reveals whether an email exists; re-registering an unverified address does not replace the password (only the mailbox owner can verify); a verified address receives an "account exists" notice (max one per 10 minutes). Concurrent duplicates are settled by the unique indexes.
- **Sign-in**: generic 401s; per-IP (3 failures / 15 min) and per-account (10 / 15 min) limits; session ID regenerated on login; no session exists until every required step is done. **Step-up policy**: the first successful sign-in of an account trusts that browser (HttpOnly cookie `bean.dev.<userId>`, one per account so several accounts can share a browser; only an HMAC is stored); afterwards an unrecognised browser must enter an emailed code. `LOGIN_STEP_UP=off` disables it. Risk events beyond "new device" (IP reputation, velocity) are not implemented.
- **Password reset / change**: ends **all** sessions, forgets trusted devices, verifies a still-unverified address, notifies the owner by email, audits.
- **Email change**: current password, then a code sent to the new address; the old address is notified at request and at completion; other sessions end.
- **Organizations**: creation, owner membership and audit in one transaction; optional idempotency key replays the first response; a conflict leaves nothing behind. Onboarding state is derived from real rows, so it is resumable and cannot duplicate anything.
- **Invitations**: only an owner/admin may invite (admins: `member` only); acceptance requires a signed-in, verified account whose email equals the invited address, and re-checks, under a tenant lock, that the invitation is pending and unexpired, the tenant is active and the inviter still holds the authority needed for the invited role. Lock order is tenant row, then invitation row; concurrent acceptance yields exactly one membership.
- **Ownership transfer**: owner only, emailed code bound to the tenant and target, atomic promote/demote under the tenant lock; exactly one owner remains.
- **Authorization (option A)**: tenant-scoped actions are allowed when the account role grants the permission (unchanged for every existing role) **or** the account has no role / the default `standard` role **and** the membership role in *that* tenant grants it (`src/tenants/tenantPermissions.js`: member = inventory read; admin/owner = inventory read/write, integrations, tenant audit). Other roles are never elevated by membership. Membership is checked on every request; the browser's selected workspace is only a request parameter.
- **Audit**: `SIGNUP`, `SIGNUP_VERIFIED`, `EMAIL_VERIFY_FAILED`, `LOGIN_*`, `LOGIN_STEP_UP_*`, `PASSWORD_RESET_*`, `EMAIL_CHANGE_*`, `CREATE/RESEND/REVOKE/ACCEPT INVITATION`, `ADD TENANT MEMBER`, `OWNERSHIP_TRANSFER_*`, `LOGOUT`. Invitee emails are masked; no passwords, codes, tokens or cookies are recorded.
- **Not implemented**: authenticator-app MFA (the sign-in flow is a challenge state machine so TOTP can be added without changing clients), per-company custom roles (decision: option A), forced logout of a single other session from the UI.

## 3. Configuration

See `.env.example`. Summary: `APP_BASE_URL` (must be one of `APP_ORIGINS`; the only source of email links), `MAIL_TRANSPORT` (`smtp` | `outbox` | `capture`), `SMTP_HOST/PORT/SECURE/USER/PASSWORD`, `MAIL_FROM_ADDRESS/NAME`, `OTP_PEPPER` (optional), `LOGIN_STEP_UP`. Startup fails with an actionable message when `MAIL_TRANSPORT=smtp` lacks host or sender, when `SMTP_USER`/`SMTP_PASSWORD` are not set together, or when production uses a non-SMTP transport. STARTTLS is required unless implicit TLS is selected; plaintext SMTP is not possible.

## 4. Migrations 013-016

| File | Content |
|---|---|
| `013_identity_users.sql` | `users.email_verified_at`, `password_changed_at`, `full_name`; role `standard` (TENANTS_CREATE). **Backfill (once, when the column is added): every existing account is marked verified as of its creation.** No role or membership is changed. |
| `014_auth_challenges.sql` | `auth_challenges`, `trusted_devices` |
| `015_tenant_invitations.sql` | `tenant_invitations` |
| `016_idempotency_keys.sql` | `idempotency_keys` |

All are additive and idempotent. Rollback for 013-016: `DROP TABLE idempotency_keys, tenant_invitations, trusted_devices, auth_challenges;` and `ALTER TABLE users DROP COLUMN email_verified_at, DROP COLUMN password_changed_at, DROP COLUMN full_name;` (restores the previous behavior, but the application code from before this change must be deployed with it).

Deployment order: apply migrations (`npm run migrate:status`, then `apply`), configure SMTP, deploy the backend, deploy the frontend. Old frontends calling the old signup body receive `400` (full name required).

## 5. Verification evidence

See `docs/identity/test-report.md`.
