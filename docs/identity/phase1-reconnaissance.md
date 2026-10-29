# Identity and organization management: Phase 1 reconnaissance report

Date: 2026-10-29. Scope of this phase: read-only inspection. No application code, migration, credential or data was changed. The Neon database was queried with `default_transaction_read_only = on` (schema catalog and row counts only; no secrets or row contents were read).

Repositories: backend `bean/backend` (Express 5, PostgreSQL, HEAD `bed221e`, clean tree) and a **separate git repository** `bean-frontend/bean-frontend` (React 19, Vite 8, react-router 7, vitest, eslint, prettier; HEAD `6339447`).

Baselines before any change: backend `DATABASE_URL= npm test` 77 pass (last run 2026-10-28); frontend `vitest run` 93 pass in 7 files, `eslint .` no findings.

## 1. Current architecture and authentication flow

- **Sessions**: `express-session` with a PostgreSQL store (`session` table, `sess` JSON holds `userId`, `authenticatedAt`). Cookie `bean.sid`: HttpOnly, SameSite `lax` by default, Secure in production, 1 h rolling, 6 h absolute (enforced in `sessionAuthMiddleware`). The session ID is regenerated on login. Every protected request reloads the user (`is_disabled = false AND deleted_at IS NULL`).
- **CSRF**: no tokens. Non-GET requests need an `Origin` in `APP_ORIGINS` (`requireTrustedOrigin`); CORS is credentialed and allow-listed.
- **Register** (`POST /auth/signup/`): validates username/email/password, inserts `users` (bcrypt cost 12, **no role**, no verification), audits `SIGNUP`, returns 201. The account can log in immediately. The UI says "ask your administrator for access".
- **Login** (`POST /auth/login/`): **email** + password only (the frontend sends email too); generic 401; 3 failed attempts per 15 min per IP; audits `LOGIN_SUCCESS` / `LOGIN_FAILURE`.
- **Authorization has two independent layers**: account permissions (`users.role_id` → `role_permissions` → `permissions`, global across all organizations) **and** tenant membership (`tenant_members.membership_role` in `owner|admin|member`). Module routes need both (for example inventory needs `INVENTORY_READ` and membership). Tenant creation needs `TENANTS_CREATE`.
- **Tenants**: `POST /tenants` (transactional: tenant + owner row + audit), members CRUD with last-owner and self-role safeguards, `FOR UPDATE` tenant lock. Non-members get 404.
- **Audit**: `audit_logs` via `composeAuditLogs`, transactional for mutations; append-only trigger since migration 012.
- **Email**: none. No mailer, SMTP config, nodemailer or notification code exists (`grep` found nothing).

## 2. Actual schema (live Neon, 12 migrations recorded)

| Table | Relevant columns / constraints |
|---|---|
| `users` | `id`, `email` (unique + unique `lower(email)`), `username` (unique + unique `lower`), `password_hash`, `created_at`, `role_id` → `roles`, `is_disabled`, `deleted_at`. **No** `email_verified_at`, display name, last login or password-changed timestamp. |
| `roles`, `permissions`, `role_permissions` | global; roles in use: `dev`, `admin` (identical permission sets, both include `PLATFORM_AUDIT_READ`) |
| `tenants` | `id`, `name`, `slug` (unique), `status` in `active|suspended|deleted`, timestamps |
| `tenant_members` | PK `(tenant_id, user_id)`, `membership_role` CHECK `owner|admin|member`, `created_at`; cascades on tenant/user delete. **No status column.** |
| `session` | `sid`, `sess` json, `expire` |
| `audit_logs` | `user_id`, `tenant_id`, `action`, `table_name`, `record_id`, `old_data`, `new_data`, `created_at` (append-only trigger) |
| Missing entirely | email verification / OTP / challenge storage, password-reset tokens, invitations, onboarding state, idempotency keys, MFA factors, tenant-specific roles or permissions |

Row counts: 5 users (2 without a role), 3 tenants, 4 memberships, 5 sessions, 234 audit rows. Two accounts are seed/operator accounts (`seedowner` uses the undeliverable domain `bean.local`).

## 3. Existing routes, middleware and screens

Backend: 58 endpoints documented in `docs/api/API_REFERENCE.md`. Reusable: `sessionAuthMiddleware`, `requirePermission`, `requireTenantMember`, `requireTrustedOrigin`, rate-limit pattern (`express-rate-limit`), `composeAuditLogs`, `paginationMiddleware`, migration runner, API-doc generator and coverage guard, test patterns (fake-pool HTTP tests; `*_test` DB harness).

Frontend routes: `/login`, `/signup`, protected `/` (overview), `/inventory`, `/audit`, `/integrations[/:id]`, `/members`. Reusable: `AuthContext` (session restore, expiry handling), `api.js` (credentialed fetch, code→safe-message map, session revision guard), `OrganizationProvider` + switcher (already supports many organizations; selection is only a request parameter, the server re-checks), `MembersPage` (role change/remove/leave with capability hints), `ui.jsx` (`Field`, `Button`, `Dialog`, `Notice`), `DESIGN.md`/`PRODUCT.md` brand rules, test setup. Not present: any verify/forgot/reset/invitation/onboarding/security-settings screen, password visibility toggle (`Field` is a plain input), invitation or pending-member UI.

## 4. Feature map

| Requested capability | Status |
|---|---|
| Public registration | Extend (works; add verification) |
| Email verification, OTP, SMTP | **Missing** |
| Login with generic errors and rate limits | Exists (IP-only limiter; add per-account) |
| Step-up / risk-triggered OTP | **Missing** |
| Password recovery, email change | **Missing** |
| Session rotation on login, logout | Exists; **session revocation on password/email change missing** |
| Password visibility toggle | **Missing** (frontend) |
| Create organization | Exists; add idempotency and onboarding wiring |
| Multiple organizations, switcher | Exists (frontend and API); extend with onboarding |
| Invitations, pending list, resend, revoke | **Missing** (today only "add an existing account by email/username", which lets an admin attach any active account without that person's consent) |
| Role edit, remove, last-owner guard | Exists |
| Ownership transfer | Only the two-step promote-then-leave convention; no atomic endpoint |
| Granular company RBAC | **Gap**: tenant roles are three fixed enum values; permissions are global per account |
| Audit of the new events | Mechanism exists; new actions needed |
| Authenticator-app MFA | Not implemented (architect only) |

## 5. Security gaps found

1. No email verification: anyone can register any address and use it immediately; invitations cannot be tied to proof of address control.
2. No password recovery; a forgotten password has no path except operator action.
3. Passwords can change nowhere, so session revocation has never existed; sessions can only be removed by logout or expiry.
4. `POST /tenants/:id/members` adds any active account (by email/username) with no consent or verification from the target; it also enumerates usernames and emails (`USER_NOT_FOUND`) to every tenant admin.
5. Signup answers 409 for existing accounts (enumeration); documented earlier, still present.
6. Login throttling is per IP only; behind a proxy that IP is shared (`trust proxy` deferred by you).
7. Authorization model mismatch: because account permissions are global, a member of company B inherits whatever the account role grants everywhere, bounded only by membership.
8. Tenant creation is not idempotent (a double submit yields one success and one 409 slug conflict, but a retry with a new slug creates a second company).
9. No `Cache-Control` / security-header review of new pages is needed yet; helmet is on for the API.

## 6. Proposed migration plan (numbering continues at 013; each idempotent, additive, tested first on a local `*_test` database, none applied to Neon without approval)

- **013 `users` verification**: add `email_verified_at timestamptz NULL`, `password_changed_at timestamptz NULL`. **Backfill decision needed** (see section 9): proposed to mark existing users verified with `email_verified_at = created_at`, because they predate the requirement; recorded as a documented backfill, never silently.
- **014 `auth_challenges`**: `id`, `user_id`, `purpose` (CHECK: `verify_email|login_step_up|password_reset|email_change|sensitive_action`), `email` (the address the code was sent to, normalized), `secret_hash` (HMAC-SHA-256 of OTP/token with a server pepper), `attempts`, `max_attempts`, `expires_at`, `consumed_at`, `superseded_at`, `request_ip_hash`, `created_at`. Partial unique index: one live challenge per `(user_id, purpose)`; a new request supersedes the previous (documented policy). Index on `expires_at` for cleanup.
- **015 `tenant_invitations`**: `id`, `tenant_id` → tenants, `email_normalized`, `membership_role` (CHECK as `tenant_members`), `token_hash` (unique), `invited_by_user_id`, `status` (`pending|accepted|revoked|expired`), `expires_at`, `accepted_by_user_id`, `accepted_at`, `created_at`; partial unique `(tenant_id, email_normalized) WHERE status='pending'`.
- **016 `idempotency_keys`** (small): `(user_id, key)` PK, `request_hash`, `response_body`, `created_at`, for tenant creation and invitation sends.
- **Onboarding progress needs no table**: it is derived (verified? member of any tenant? has a pending invitation? tenant profile complete?) so it is resumable and cannot duplicate tenants.
- **Reserved, not built**: `user_mfa_factors`; the login flow is a state machine with `requiredSteps` so TOTP slots in without breaking clients. Nothing will claim MFA until it exists.
- Existing `session` table is reused for revocation (`DELETE FROM session WHERE sess->>'userId' = $1`; no new table).
- Roles/RBAC: **no migration until decision 3 below is made.**
- Rollback: every migration only adds objects/columns; recovery is `DROP` of the new objects (documented in the migration header); the backfill is reversible by `UPDATE users SET email_verified_at = NULL WHERE email_verified_at = created_at AND <listed ids>`.
- A dedicated local test database is required first (none exists on this machine; see risks).

## 7. Proposed endpoint contract (all unsafe methods keep the Origin check; errors use `{ error: { code, message, requestId } }`; every response generic where enumeration is possible)

Authentication
- `POST /auth/signup` (extended): same body; always `202 { status: "verification_sent" }` whether or not the email exists (existing accounts get a "someone tried to register" email); creates the account unverified, sends an OTP.
- `POST /auth/verify-email` `{ email, code }`; `POST /auth/verify-email/resend` `{ email }` (cooldown).
- `POST /auth/login` (extended): `200 { user, nextStep: "workspace|onboarding" }`, or `202 { challenge: "email_otp", challengeId }` when step-up applies, or `403 EMAIL_NOT_VERIFIED`. No full session until all steps pass.
- `POST /auth/login/verify` `{ challengeId, code }`.
- `POST /auth/password/forgot` `{ email }` (always 202); `POST /auth/password/reset` `{ token, newPassword }` (single use; revokes all sessions).
- `POST /auth/email-change/request` `{ newEmail, currentPassword }` (OTP to the new address, notice to the old); `POST /auth/email-change/confirm` `{ code }`.
- `GET /auth/me` (extended): adds `emailVerified`, `onboarding: { step }`, membership count; `GET /auth/sessions`, `DELETE /auth/sessions/:id` optional.

Organizations and invitations
- `GET /onboarding` (derived state), `POST /tenants` (existing; add `Idempotency-Key`, onboarding details).
- `POST /tenants/:id/invitations` `{ email, role }`, `GET /tenants/:id/invitations`, `POST /tenants/:id/invitations/:invId/resend`, `DELETE /tenants/:id/invitations/:invId`.
- `GET /invitations/preview` (token in POST body, never in URL logs) and `POST /invitations/accept` `{ token }`: requires an authenticated, **verified** user whose email equals the invited email; one transaction locks the invitation, re-checks inviter authority and tenant status, inserts the membership, marks accepted.
- `POST /tenants/:id/ownership-transfer` `{ newOwnerUserId }` with OTP step-up: atomic promote + demote + audit.
- Existing `POST /tenants/:id/members` (add by email/username): proposed to be restricted or retired in favour of invitations (decision 5).

Audit actions to add: `SIGNUP_VERIFIED`, `EMAIL_VERIFY_FAILED`, `OTP_ISSUED`, `LOGIN_STEP_UP`, `PASSWORD_RESET_REQUESTED/COMPLETED`, `EMAIL_CHANGE_REQUESTED/CONFIRMED`, `SESSIONS_REVOKED`, `INVITATION_CREATED/RESENT/REVOKED/ACCEPTED`, `OWNERSHIP_TRANSFERRED`. No codes, tokens or passwords in any payload.

## 8. Ordered milestones (each: tests, diff review, report, stop)

1. Local PostgreSQL `*_test` database + migrations 013-014 + mail transport module (SMTP + capture transport) + config validation + `.env.example`.
2. OTP service and email verification; signup/login changes; backend tests.
3. Password reset and email change; session revocation.
4. Step-up OTP and login state machine.
5. Migrations 015-016, organization onboarding endpoint, idempotent tenant creation, multi-tenant regression.
6. Invitations (create/list/resend/revoke/accept), ownership transfer, member-management changes.
7. RBAC changes per the decision taken, audit coverage doc.
8. Frontend: password toggle in `ui.jsx`, auth screens, onboarding wizard, invitation acceptance, members/invitations UI, switcher polish.
9. Cross-tenant and regression suites; Postman/API docs regenerated; deployment guide.

## 9. Risks, assumptions and decisions needed from you

**Decisions**

1. **Existing users**: backfill `email_verified_at = created_at` for the 5 existing accounts (so nobody is locked out), or require them to verify? The seed accounts use `bean.local`, which cannot receive mail.
2. **Default permissions for new accounts**: today self-registered users have no role and therefore cannot create a company (`TENANTS_CREATE`) or read inventory even as a member. For self-service onboarding they need something. Recommended: create a minimal role `standard` assigned **after email verification** carrying `TENANTS_CREATE` only, and move module access control to the tenant role (decision 3). Alternative: keep roles administrator-assigned (onboarding then cannot be self-service).
3. **Company-specific granular RBAC** (largest design choice). Option A (recommended for this milestone): keep the three tenant roles and derive tenant permissions from them with a fixed, documented mapping (for example members read, admins write, owners manage), keeping account permissions only for platform and company creation. Option B: new `tenant_roles` and `tenant_role_permissions` tables with per-company custom roles. B is a larger migration and every module guard changes. Existing access must be preserved either way.
4. **Authenticator-app MFA**: confirm it stays out of scope (architecture only).
5. **Add-by-email without consent** (`POST /tenants/:id/members`): retire it in favour of invitations, or keep it restricted to already-verified accounts?
6. **Step-up policy**: which events count as "risk-triggered" (new device, new IP, after password reset, ownership transfer, email change, role change to owner)? Proposed OTP policy: 6 digits, 10 minute expiry, 5 attempts, 60 s resend cooldown, max 5 sends/hour/address, previous challenge superseded; reset/invitation tokens 32 bytes, 1 h / 7 days.
7. **SMTP**: provider, sender address, and the public frontend base URL for links. Adding `nodemailer` is a new dependency (the only realistic choice); approve it? Email is delivery-only; no SMTP credentials are needed until the optional end-to-end check.
8. **Username vs display name**: the schema has only `username` (3-20 alphanumeric). Keep it, or add a full-name field to registration and member lists?

**Risks and assumptions**

- No local PostgreSQL exists here (earlier sessions confirmed). Phase 7 requires testing migrations on a populated test database first; installing PostgreSQL locally (or pointing at one you provide) is a prerequisite for milestone 1. Neon will not be used for tests (project rule).
- Two repositories: backend and frontend commit and deploy separately; backend contract changes need a coordinated frontend release (the frontend maps error codes to messages and never shows server text).
- Cookies are SameSite=lax; if the frontend and API are deployed on different sites, cookies and the Origin check will need a deployment decision.
- Email delivery cannot be verified end to end without a real SMTP account; tests use a capture transport.
- `trust proxy` remains deferred, so per-IP limits are weaker behind a proxy; per-account throttling will be added independently.
- Assumes `bean.local` and other undeliverable addresses are not real users.

**Stopped here.** Please approve (or amend) the plan and answer decisions 1-8; I will not change code, apply migrations, seed accounts or touch Neon until then.
