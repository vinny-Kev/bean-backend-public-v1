# Bean Enterprise Management API reference

Generated from `scripts/api-docs` (76 endpoints). Do not edit by hand: run `npm run docs:api`. The same content ships as the request descriptions of `postman/Bean-Enterprise-Management.postman_collection.json`.

## Conventions

- **Base URL**: `http://localhost:3000` by default (`PORT` / `HOST` in `.env`).
- **Sessions**: `POST /auth/login/` sets the `bean.sid` HttpOnly cookie (1 hour sliding, 6 hour absolute lifetime) in the PostgreSQL session store.
- **CSRF**: there is no CSRF token. Every non-GET/HEAD/OPTIONS request (except integration event delivery) must send an `Origin` header that exactly matches an `APP_ORIGINS` entry; other origins get `403 ORIGIN_DENIED`. Cookies are `SameSite=Lax` by default.
- **Account permissions** come from the user's role (`roles` → `role_permissions`); **tenant authority** comes from `tenant_members` (`owner` / `admin` / `member`). Clients never supply a trusted tenant: the URL value only selects it, and non-members get 404 (or an empty list) so IDs cannot be probed.
- **Error shapes**: `{ "message": "..." }` (auth, inventory, audit, parts of integrations) and `{ "error": { "code", "message", "requestId"? } }` (tenants, integration lifecycle, tickets, global handler). Permission failures carry both. 500s never include internals.
- **Pagination** (`page`/`limit`/`offset`): `limit` 1–20 and `page` XOR `offset`.
- **Rate limits**: signup 5/h/IP, login 3 failures/15 min/IP, tenant creation 10/h/user, integration registration 20/h/user, credential rotation 10/h/IP, event delivery 120/min/IP. Body limits: JSON 100 KB, form 10 KB.
- **Audit**: see `docs/qa/audit-coverage.md`.

## Endpoint index

| # | Method | Path | Name | Session | Permission |
|---|---|---|---|---|---|
| 1 | GET | `/health` | Liveness | no | - |
| 2 | GET | `/health/ready` | Readiness | no | - |
| 3 | POST | `/auth/logout` | Log out | no | - |
| 4 | POST | `/auth/signup/` | Sign up | no | - |
| 5 | POST | `/auth/verify-email` | Verify email | no | - |
| 6 | POST | `/auth/verify-email/resend` | Resend verification code | no | - |
| 7 | POST | `/auth/login/` | Log in | no | - |
| 8 | POST | `/auth/login/verify` | Complete sign-in (emailed code) | no | - |
| 9 | GET | `/auth/me` | Current user | yes | - |
| 10 | GET | `/onboarding` | Onboarding state | yes | - |
| 11 | POST | `/auth/password/forgot` | Request password reset | no | - |
| 12 | POST | `/auth/password/reset` | Reset password | no | - |
| 13 | POST | `/auth/email-change/request` | Request email change | yes | - |
| 14 | POST | `/auth/email-change/confirm` | Confirm email change | yes | - |
| 15 | GET | `/tenants/` | List my tenants | yes | - |
| 16 | POST | `/tenants/` | Create tenant | yes | `TENANTS_CREATE` |
| 17 | GET | `/tenants/:tenant_id` | Get tenant | yes | - |
| 18 | GET | `/tenants/:tenant_id/members` | List members | yes | - |
| 19 | GET | `/tenants/:tenant_id/members/:user_id` | Get member | yes | - |
| 20 | POST | `/tenants/:tenant_id/members` | Add member | yes | - |
| 21 | PATCH | `/tenants/:tenant_id/members/:user_id` | Change member role | yes | - |
| 22 | DELETE | `/tenants/:tenant_id/members/:user_id` | Remove member / leave tenant | yes | - |
| 23 | GET | `/tenants/:tenant_id/invitations` | List invitations | yes | - |
| 24 | POST | `/tenants/:tenant_id/invitations` | Invite a teammate | yes | - |
| 25 | POST | `/tenants/:tenant_id/invitations/:invitation_id/resend` | Resend invitation | yes | - |
| 26 | DELETE | `/tenants/:tenant_id/invitations/:invitation_id` | Revoke invitation | yes | - |
| 27 | POST | `/tenants/:tenant_id/ownership-transfer/request` | Request ownership transfer | yes | - |
| 28 | POST | `/tenants/:tenant_id/ownership-transfer/confirm` | Confirm ownership transfer | yes | - |
| 29 | POST | `/invitations/preview` | Preview invitation (token) | no | - |
| 30 | GET | `/invitations/mine` | My pending invitations | yes | - |
| 31 | POST | `/invitations/accept` | Accept invitation (token) | yes | - |
| 32 | POST | `/invitations/:invitation_id/accept` | Accept invitation (from my list) | yes | - |
| 33 | GET | `/inventory/health/` | Inventory route check | no | - |
| 34 | GET | `/inventory/tenants/:tenant_id/items` | List inventory items | yes | `INVENTORY_READ` |
| 35 | POST | `/inventory/tenants/:tenant_id/items` | Create inventory item | yes | `INVENTORY_CREATE` |
| 36 | PUT | `/inventory/tenants/:tenant_id/items/:id` | Update inventory item | yes | `INVENTORY_UPDATE` |
| 37 | GET | `/audit/all` | Platform audit log (all tenants) | yes | `PLATFORM_AUDIT_READ` |
| 38 | GET | `/audit/tenants/:tenant_id` | Tenant audit log | yes | `AUDIT_READ` |
| 39 | GET | `/integrations/all/:tenant_id` | List tenant integrations | yes | `INTEGRATIONS_READ` |
| 40 | POST | `/integrations/tenants/:tenant_id/apps` | Register integration | yes | `INTEGRATIONS_MANAGE` |
| 41 | GET | `/integrations/:integration_id` | Get integration | yes | `INTEGRATIONS_READ` |
| 42 | PUT | `/integrations/:integration_id/subscriptions` | Set event subscriptions | yes | `INTEGRATIONS_MANAGE` |
| 43 | PUT | `/integrations/:integration_id/user-mappings` | Map external user | yes | `INTEGRATIONS_MANAGE` |
| 44 | POST | `/integrations/:integration_id/activate` | Activate integration | yes | `INTEGRATIONS_MANAGE` |
| 45 | POST | `/integrations/:integration_id/suspend` | Suspend integration | yes | `INTEGRATIONS_MANAGE` |
| 46 | POST | `/integrations/:integration_id/disconnect` | Disconnect integration | yes | `INTEGRATIONS_MANAGE` |
| 47 | POST | `/integrations/:integration_id/credentials/rotate` | Rotate credential | yes | `INTEGRATIONS_MANAGE` |
| 48 | GET | `/integrations/tenants/:tenant_id/settings` | Get integration settings | yes | `INTEGRATIONS_READ` |
| 49 | PUT | `/integrations/tenants/:tenant_id/settings/inventory-policy` | Set inventory shortage policy | yes | `INTEGRATIONS_MANAGE` |
| 50 | POST | `/integrations/:integration_id/events` | Deliver integration event (app → Bean) | no | - |
| 51 | GET | `/integrations/events` | Search integration events | yes | `INTEGRATIONS_READ` |
| 52 | GET | `/integrations/events/:event_id` | Get event timeline | yes | `INTEGRATIONS_READ` |
| 53 | POST | `/integrations/events/:event_id/retry` | Retry failed event | yes | `INTEGRATIONS_MANAGE` |
| 54 | GET | `/integrations/diagnostics` | Search delivery diagnostics | yes | `INTEGRATIONS_READ` |
| 55 | GET | `/integrations/diagnostics/unauthorized` | Unauthorized delivery attempts (platform) | yes | `PLATFORM_AUDIT_READ` |
| 56 | GET | `/integrations/:integration_id/activity` | Integration activity feed | yes | `INTEGRATIONS_READ` |
| 57 | GET | `/integrations/:integration_id/audit` | Integration audit history | yes | `INTEGRATIONS_READ` |
| 58 | GET | `/integrations/:integration_id/analytics` | Integration analytics | yes | `INTEGRATIONS_READ` |
| 59 | GET | `/ticketing/tenants/:tenantId/inboxes` | List inboxes | yes | - |
| 60 | POST | `/ticketing/tenants/:tenantId/inboxes` | Create inbox | yes | - |
| 61 | GET | `/ticketing/tenants/:tenantId/tickets` | List tickets | yes | - |
| 62 | POST | `/ticketing/tenants/:tenantId/tickets` | Create ticket | yes | - |
| 63 | GET | `/ticketing/tenants/:tenantId/tickets/:ticketId` | Get ticket | yes | - |
| 64 | GET | `/ticketing/tenants/:tenantId/tickets/:ticketId/assignments` | List assignments | yes | - |
| 65 | POST | `/ticketing/tenants/:tenantId/tickets/:ticketId/assignments` | Assign ticket | yes | - |
| 66 | POST | `/ticketing/tenants/:tenantId/tickets/:ticketId/acknowledge` | Acknowledge ticket | yes | - |
| 67 | PATCH | `/ticketing/tenants/:tenantId/tickets/:ticketId/status` | Change ticket status | yes | - |
| 68 | GET | `/ticketing/tenants/:tenantId/tickets/:ticketId/comments` | List comments | yes | - |
| 69 | POST | `/ticketing/tenants/:tenantId/tickets/:ticketId/comments` | Add comment | yes | - |
| 70 | GET | `/ticketing/tenants/:tenantId/tickets/:ticketId/activity` | Ticket activity history | yes | - |
| 71 | GET | `/ticketing/tenants/:tenantId/tickets/:ticketId/story-points` | Get story-point estimate | yes | - |
| 72 | PUT | `/ticketing/tenants/:tenantId/tickets/:ticketId/story-points` | Set story-point estimate | yes | - |
| 73 | GET | `/ticketing/tenants/:tenantId/tickets/:ticketId/verifications` | List work verifications | yes | - |
| 74 | POST | `/ticketing/tenants/:tenantId/tickets/:ticketId/verifications` | Verify work | yes | - |
| 75 | POST | `/ticketing/tenants/:tenantId/tickets/:ticketId/verifications/:verificationId/revoke` | Revoke verification | yes | - |
| 76 | GET | `/ticketing/tenants/:tenantId/work-summary/:userId` | Employee work summary | yes | - |

## Health

### GET `/health` — Liveness

#### Purpose
Liveness probe: confirms the Node process is up and serving HTTP. It never queries the database, so a database outage does not make the process look dead. Use it for container/process liveness checks.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. Mounted before CORS, sessions and the origin check, so no cookie or `Origin` header is needed.

#### Prerequisites
- None.

#### Headers
- `Cookie: bean.sid=...`: not used.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Process is serving requests.

  ```json
  {
    "status": "ok"
  }
  ```

#### Side effects
- None. Health probes never write audit entries or touch the session store.
- Audit: None (deliberately: routine polling would be noise).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes: read-only and cheap. Responses carry `Cache-Control: no-store`.

### GET `/health/ready` — Readiness

#### Purpose
Readiness probe: runs `SELECT 1` through the shared connection pool (2 second timeout) to confirm the database is reachable. Use it for load-balancer / orchestrator readiness so traffic stops while the database is down.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public, like `/health`.

#### Prerequisites
- None.

#### Headers
- `Cookie: bean.sid=...`: not used.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Database reachable.

  ```json
  {
    "status": "ok",
    "checks": {
      "database": "ok"
    }
  }
  ```
- **503 Service Unavailable**: Database unreachable or the check timed out. No host, credential or error text is included.

  ```json
  {
    "status": "unavailable",
    "checks": {
      "database": "unavailable"
    }
  }
  ```

#### Side effects
- None beyond one `SELECT 1`. No audit entries.
- Audit: None.

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes: read-only. Avoid sub-second polling intervals; each call borrows a pooled connection.

## Authentication

### POST `/auth/logout` — Log out

#### Purpose
Destroys the server-side session and clears the `bean.sid` cookie. Safe to call without a session.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- No session required; if one exists it is destroyed.

#### Prerequisites
- None.

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **204 No Content**: Always 204, with or without a session. Empty body.

#### Side effects
- Deletes the session row.
- `LOGOUT` audit entry when a session existed (a failed audit write is logged but never blocks logout).
- Audit: `LOGOUT` (table `session`) when a signed-in session is destroyed.

#### Testing notes
- Asserts status 204 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (idempotent; later calls just return 204).

### POST `/auth/signup/` — Sign up

#### Purpose
Registers an account in the unverified state and emails a 6-digit verification code. No session is created and the account cannot sign in until the address is verified (**Verify email**). The answer is the same whether or not the address is already registered.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. Rate limited to 5 requests per hour per IP.

#### Prerequisites
- Collection variables `signupFullName`, `signupUsername`, `signupEmail`, `signupPassword` (the pre-request script fills the username/email; set `signupPassword` in your environment, never in the collection).

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `fullName` | string | yes | 2-100 characters: letters (any script), single spaces, hyphens, apostrophes, periods. |
| `username` | string | yes | 3-20 letters/digits, single spaces between words. Unique case-insensitively. |
| `email` | string | yes | Valid email, max 254 characters; trimmed and lower-cased; unique case-insensitively. |
| `password` | string | yes | 8-20 characters, no whitespace, lower + upper + digit + symbol, at most 72 UTF-8 bytes. |

Valid example:
```json
{
  "fullName": "{{signupFullName}}",
  "username": "{{signupUsername}}",
  "email": "{{signupEmail}}",
  "password": "{{signupPassword}}"
}
```

Invalid example (400: Validation message names the first failing rule.):
```json
{
  "fullName": "X",
  "username": "ab",
  "email": "nope",
  "password": "weak"
}
```

#### Expected responses
- **202 Accepted**: Always for a valid request (new address, existing unverified address, or an address that already has an account).

  ```json
  {
    "status": "verification_sent",
    "codeLength": 6,
    "retryAfterSeconds": 60,
    "message": "If the details are valid, a verification code has been sent to the email address. Enter it to activate the account."
  }
  ```
- **400 Bad Request**: Validation failure (`Enter your full name ...`, `A valid email address is required.`, password rules, ...).

  ```json
  {
    "message": "Username must be 3 to 20 alphanumeric characters."
  }
  ```
- **409 Conflict**: Only username conflicts are explicit; email conflicts are not revealed.

  ```json
  {
    "error": {
      "code": "USERNAME_TAKEN",
      "message": "That username is already taken. Choose another.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Signup rate limit (default text body).

  ```json
  Too many requests, please try again later.
  ```

#### Side effects
- Inserts an unverified `users` row (bcrypt hash), a hashed `verify_email` challenge and a `SIGNUP` audit row in one transaction; then sends the code by email.
- A second registration for an unverified address never replaces the stored password; for a verified address an "account exists" notice is emailed (at most one per 10 minutes).
- Audit: `SIGNUP` (table `users`, transactional; no email or credentials in the entry).

#### Testing notes
- Asserts status 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: repeats give the same 202 and at most one code per 60 seconds.

### POST `/auth/verify-email` — Verify email

#### Purpose
Submits the 6-digit code from the verification email. On success the account becomes active and receives the `standard` account role (which allows creating an organization). The caller must still sign in.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. Rate limited to 20 requests per 15 minutes per IP; each code also allows 5 wrong attempts.

#### Prerequisites
- **Sign up** first; set `verificationCode` to the code from the email (in development with `MAIL_TRANSPORT=outbox` read it from `.mail-outbox/`).

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | The registered address. |
| `code` | string | yes | Exactly 6 digits. |

Valid example:
```json
{
  "email": "{{signupEmail}}",
  "code": "{{verificationCode}}"
}
```

Invalid example (400: `OTP_INVALID` (the counter of wrong attempts increases).):
```json
{
  "email": "{{signupEmail}}",
  "code": "000000"
}
```

#### Expected responses
- **200 OK**: Verified.

  ```json
  {
    "status": "verified",
    "message": "Email verified. You can sign in now."
  }
  ```
- **400 Bad Request**: Wrong code. Also `OTP_EXPIRED`, `OTP_LOCKED` (5 wrong attempts: request a new code) and `OTP_ALREADY_USED` (sign-in challenge already completed).

  ```json
  {
    "error": {
      "code": "OTP_INVALID",
      "message": "That code is not correct.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Per-IP rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many attempts. Try again later."
    }
  }
  ```

#### Side effects
- Sets `email_verified_at`, assigns the `standard` role if the user had none, consumes the challenge, audits.
- Audit: `SIGNUP_VERIFIED`; failures: `EMAIL_VERIFY_FAILED` (reason only, never the code).

#### Testing notes
- Asserts status 200 or 400 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a used code cannot be replayed.

### POST `/auth/verify-email/resend` — Resend verification code

#### Purpose
Sends a fresh verification code (superseding the previous one). Always answers 202 so it cannot be used to discover which addresses are registered.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. 10 requests per hour per IP; a 60-second cooldown and 5 codes per hour per account apply silently.

#### Prerequisites
- None.

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | Address to resend to. |

Valid example:
```json
{
  "email": "{{signupEmail}}"
}
```

#### Expected responses
- **202 Accepted**: Always.

  ```json
  {
    "status": "verification_sent",
    "codeLength": 6,
    "retryAfterSeconds": 60,
    "message": "If that address has an unverified account, a new code has been sent."
  }
  ```
- **429 Too Many Requests**: Per-IP rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many attempts. Try again later."
    }
  }
  ```

#### Side effects
- Supersedes the live challenge and emails a new one (only for an existing unverified account outside the cooldown).
- Audit: None.

#### Testing notes
- Asserts status 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (cooldown applies).

### POST `/auth/login/` — Log in

#### Purpose
Authenticates with email and password. Success starts a session (HttpOnly `bean.sid`, regenerated on login). Unverified accounts are refused. A browser that is not a trusted device for the account must first pass an emailed code: the response is 202 and **no session exists** until **Complete sign-in** succeeds.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. Rate limited: 3 failed attempts per 15 minutes per IP and 10 per account.

#### Prerequisites
- A verified account. Set `userEmail` and `userPassword` in your environment (never commit them).

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | Trimmed, lower-cased, max 254 characters. |
| `password` | string | yes | Non-empty, at most 72 UTF-8 bytes. |

Valid example:
```json
{
  "email": "{{userEmail}}",
  "password": "{{userPassword}}"
}
```

Invalid example (400: Email and password are required.):
```json
{
  "email": "jane@example.com"
}
```

#### Expected responses
- **200 OK**: Signed in; sets `bean.sid`. The first successful sign-in of an account also sets the `bean.dev.<userId>` trusted-device cookie (one per account).

  ```json
  {
    "message": "Login successful.",
    "user": {
      "id": 12,
      "email": "jane@example.com",
      "username": "janedoe",
      "fullName": "Jane Doe",
      "roleId": 3
    }
  }
  ```
- **202 Accepted**: Step-up required (device not yet trusted). No session cookie is set.

  ```json
  {
    "challenge": "email_otp",
    "challengeId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10",
    "codeLength": 6,
    "retryAfterSeconds": 60,
    "expiresInMinutes": 10,
    "message": "Enter the code we emailed you to finish signing in."
  }
  ```
- **400 Bad Request**: Missing or oversized credentials.

  ```json
  {
    "message": "Email and password are required."
  }
  ```
- **401 Unauthorized**: Unknown, disabled or wrong-password account (identical for all).

  ```json
  {
    "message": "Invalid email or password."
  }
  ```
- **403 Forbidden**: Correct password but the address is unverified.

  ```json
  {
    "error": {
      "code": "EMAIL_NOT_VERIFIED",
      "message": "Verify your email address to sign in.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Step-up code requested twice within 60 seconds (has `Retry-After`). Also the rate-limit 429s.

  ```json
  {
    "error": {
      "code": "OTP_RATE_LIMITED",
      "message": "A code was just sent. Wait a moment before requesting another.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Creates a session (200) or a hashed `login_step_up` challenge plus an emailed code (202).
- Audits success, failure for existing accounts, and step-up requests.
- Audit: `LOGIN_SUCCESS`, `LOGIN_FAILURE`, `LOGIN_STEP_UP_REQUIRED` (table `session`, account level).

#### Testing notes
- Asserts status 200 or 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (failures count toward the limiter).
- The expected status is 200 or 202 depending on whether this Postman client already holds a trusted-device cookie.

### POST `/auth/login/verify` — Complete sign-in (emailed code)

#### Purpose
Finishes a step-up sign-in with the code from the email. On success the session is created (ID regenerated) and this browser becomes a trusted device.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. 20 requests per 15 minutes per IP; 5 wrong attempts per code.

#### Prerequisites
- A 202 from **Log in** (`loginChallengeId`) and the emailed code in `loginCode`.

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `challengeId` | string (UUID) | yes | The `challengeId` from the 202 login response. |
| `code` | string | yes | 6 digits. |

Valid example:
```json
{
  "challengeId": "{{loginChallengeId}}",
  "code": "{{loginCode}}"
}
```

Invalid example (400: `OTP_INVALID`.):
```json
{
  "challengeId": "x",
  "code": "1"
}
```

#### Expected responses
- **200 OK**: Signed in; sets `bean.sid` and `bean.dev.<userId>`.

  ```json
  {
    "message": "Login successful.",
    "user": {
      "id": 12,
      "email": "jane@example.com",
      "username": "janedoe",
      "fullName": "Jane Doe",
      "roleId": 3
    }
  }
  ```
- **400 Bad Request**: Wrong code. Also `OTP_EXPIRED`, `OTP_LOCKED` (5 wrong attempts: request a new code) and `OTP_ALREADY_USED` (sign-in challenge already completed).

  ```json
  {
    "error": {
      "code": "OTP_INVALID",
      "message": "That code is not correct.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Per-IP rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many attempts. Try again later."
    }
  }
  ```

#### Side effects
- Consumes the challenge, regenerates the session, registers the trusted device.
- Audit: `LOGIN_SUCCESS` (with `stepUp: email_otp`); failures `LOGIN_STEP_UP_FAILED`.

#### Testing notes
- Asserts status 200 or 400 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: codes are single use.

### GET `/auth/me` — Current user

#### Purpose
Returns the signed-in, verified account and its account-level permissions. Use it to restore UI state after a reload.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable
- Any signed-in, enabled, email-verified account.

#### Prerequisites
- Run **Log in** first.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: `Cache-Control: no-store`.

  ```json
  {
    "user": {
      "id": 12,
      "email": "jane@example.com",
      "username": "janedoe",
      "fullName": "Jane Doe",
      "roleId": 3,
      "emailVerified": true,
      "permissions": [
        "TENANTS_CREATE"
      ]
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **401 Unauthorized**: Session older than 6 hours (absolute lifetime).

  ```json
  {
    "message": "Session expired. Please log in again."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/onboarding` — Onboarding state

#### Purpose
Where the user is in the guided flow, derived from real records (nothing is stored, so it is resumable from any device): `organization` = no organization yet (create one or accept an invitation); `done` = belongs to at least one organization.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable

#### Prerequisites
- Run **Log in** first.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: `Cache-Control: no-store`.

  ```json
  {
    "data": {
      "step": "organization",
      "organizations": 0,
      "pendingInvitations": 1,
      "canCreateOrganization": true
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/auth/password/forgot` — Request password reset

#### Purpose
Emails a single-use reset link (token in the URL fragment, valid 60 minutes). Always answers 202 so it cannot reveal which addresses have accounts.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. 10 requests per hour per IP; a 60-second cooldown and 5 links per hour per account apply silently.

#### Prerequisites
- None.

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | Account address. |

Valid example:
```json
{
  "email": "{{userEmail}}"
}
```

#### Expected responses
- **202 Accepted**: Always.

  ```json
  {
    "status": "reset_requested",
    "retryAfterSeconds": 60,
    "message": "If that address has an account, a reset link has been sent."
  }
  ```
- **429 Too Many Requests**: Per-IP rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many attempts. Try again later."
    }
  }
  ```

#### Side effects
- Supersedes any live reset token and stores only its hash; emails the link.
- Audit: `PASSWORD_RESET_REQUESTED`.

#### Testing notes
- Asserts status 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (throttled).

### POST `/auth/password/reset` — Reset password

#### Purpose
Sets a new password using the emailed token. The token works once, expires after 60 minutes, ends every session of the account, forgets trusted devices, verifies the address if still unverified, and notifies the owner by email.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. 10 requests per 15 minutes per IP.

#### Prerequisites
- `resetToken` from the `#token=` fragment of the emailed link.

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `token` | string | yes | From the link. |
| `newPassword` | string | yes | Same rules as signup. |

Valid example:
```json
{
  "token": "{{resetToken}}",
  "newPassword": "{{newPassword}}"
}
```

Invalid example (400: `INVALID_PASSWORD`.):
```json
{
  "token": "x",
  "newPassword": "weak"
}
```

#### Expected responses
- **200 OK**: Changed.

  ```json
  {
    "status": "password_reset",
    "message": "Your password was changed. Sign in with the new password."
  }
  ```
- **400 Bad Request**: Unknown, used or expired token. Weak passwords give `INVALID_PASSWORD`.

  ```json
  {
    "error": {
      "code": "RESET_TOKEN_INVALID",
      "message": "This reset link is invalid or has expired. Request a new one.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Per-IP rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many attempts. Try again later."
    }
  }
  ```

#### Side effects
- Updates `password_hash` / `password_changed_at`, deletes all the user's sessions and trusted devices, consumes the token.
- Audit: `PASSWORD_RESET_COMPLETED` (number of sessions revoked).

#### Testing notes
- Asserts status 200 or 400 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: single use.

### POST `/auth/email-change/request` — Request email change

#### Purpose
Starts changing the sign-in email: proves the current password, emails a code to the NEW address and a notice to the old one. Nothing changes until the code is confirmed. The answer is the same if the new address is already registered.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable
- 10 requests per hour per user.

#### Prerequisites
- Signed in; `newEmail` variable.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `newEmail` | string | yes | Valid email, max 254. |
| `currentPassword` | string | yes | The account password. |

Valid example:
```json
{
  "newEmail": "{{newEmail}}",
  "currentPassword": "{{userPassword}}"
}
```

Invalid example (400: `INVALID_REQUEST`.):
```json
{
  "newEmail": "x"
}
```

#### Expected responses
- **202 Accepted**: Code sent if the address can be used.

  ```json
  {
    "status": "code_sent",
    "codeLength": 6,
    "retryAfterSeconds": 60,
    "message": "If the address can be used, a confirmation code has been sent to it."
  }
  ```
- **400 Bad Request**: Validation.

  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "Enter a valid new email address and your current password.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: Wrong password (audited).

  ```json
  {
    "error": {
      "code": "INVALID_PASSWORD",
      "message": "Your current password is not correct.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Cooldown (has `Retry-After`).

  ```json
  {
    "error": {
      "code": "OTP_RATE_LIMITED",
      "message": "A code was just sent. Wait a moment before requesting another.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Supersedes a previous email-change challenge; emails the code to the new address and a notice to the current one.
- Audit: `EMAIL_CHANGE_REQUESTED`, `EMAIL_CHANGE_DENIED`.

#### Testing notes
- Asserts status 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (cooldown).

### POST `/auth/email-change/confirm` — Confirm email change

#### Purpose
Completes the change with the code sent to the new address. Updates the email, ends the user's OTHER sessions (this one stays), and notifies the old address.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable
- 20 requests per 15 minutes per IP; 5 wrong attempts per code.

#### Prerequisites
- `emailChangeCode` from the new address.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `code` | string | yes | 6 digits. |

Valid example:
```json
{
  "code": "{{emailChangeCode}}"
}
```

#### Expected responses
- **200 OK**: Changed.

  ```json
  {
    "status": "email_changed",
    "message": "Your email address was changed.",
    "email": "new@example.com"
  }
  ```
- **400 Bad Request**: Wrong code. Also `OTP_EXPIRED`, `OTP_LOCKED` (5 wrong attempts: request a new code) and `OTP_ALREADY_USED` (sign-in challenge already completed).

  ```json
  {
    "error": {
      "code": "OTP_INVALID",
      "message": "That code is not correct.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **409 Conflict**: Registered by someone else meanwhile.

  ```json
  {
    "error": {
      "code": "EMAIL_UNAVAILABLE",
      "message": "That email address can no longer be used. Start again with another address.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Updates `users.email`, revokes other sessions, consumes the challenge.
- Audit: `EMAIL_CHANGE_CONFIRMED`.

#### Testing notes
- Asserts status 200 or 400 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: single use.

## Tenants

### GET `/tenants/` — List my tenants

#### Purpose
Lists the non-deleted tenants the signed-in user belongs to, with their membership role.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable
- No account permission needed.

#### Prerequisites
- Run **Log in** first.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Possibly an empty array.

  ```json
  {
    "message": "Tenants retrieved successfully.",
    "data": [
      {
        "id": 4,
        "name": "Acme Coffee",
        "slug": "acme-coffee",
        "status": "active",
        "membershipRole": "owner",
        "joinedAt": "2026-10-20T09:00:00.000Z"
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/tenants/` — Create tenant

#### Purpose
Creates an organization and makes the caller its `owner` in one transaction.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `TENANTS_CREATE`
- Tenant membership/role: not applicable
- Account-level permission; tenant roles never grant it. Rate limited to 10 creations per hour per user.

#### Prerequisites
- Signed in as an account whose role has `TENANTS_CREATE`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- `Idempotency-Key: {{$guid}}`: Optional but recommended: 8-100 characters of `A-Za-z0-9_.:-`. A retry with the same key and body replays the first response instead of creating a second organization; the same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1-255 characters after trimming. |
| `slug` | string | yes | 3-100 characters, lower-case letters/digits with single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`). Globally unique. |

Valid example:
```json
{
  "name": "Acme Coffee",
  "slug": "{{newTenantSlug}}"
}
```

Invalid example (400: Unknown keys and invalid slugs are rejected with `INVALID_TENANT`.):
```json
{
  "name": "Acme",
  "slug": "Bad Slug",
  "extra": 1
}
```

#### Expected responses
- **201 Created**: Tenant created; caller is owner.

  ```json
  {
    "message": "Tenant created.",
    "data": {
      "id": 4,
      "name": "Acme Coffee",
      "slug": "acme-coffee",
      "status": "active",
      "membershipRole": "owner",
      "createdAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "INVALID_TENANT",
      "message": "Provide a name (1-255 characters) and a lowercase slug (3-100 characters, letters, digits and single hyphens)."
    }
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **409 Conflict**: Duplicate slug.

  ```json
  {
    "error": {
      "code": "TENANT_SLUG_TAKEN",
      "message": "That tenant slug is already in use."
    }
  }
  ```
- **429 Too Many Requests**: Per-user hourly limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many tenant creation requests."
    }
  }
  ```
- **422 Unprocessable Entity**: Same key, different body.

  ```json
  {
    "error": {
      "code": "IDEMPOTENCY_KEY_REUSED",
      "message": "That Idempotency-Key was already used with different details."
    }
  }
  ```

#### Side effects
- Inserts `tenants` and an owner `tenant_members` row.
- Writes a `CREATE TENANT` audit entry in the same transaction.
- Audit: `CREATE TENANT` (table `tenants`, tenant-scoped).

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: the slug becomes taken. Clear `newTenantSlug` for a fresh one.

### GET `/tenants/:tenant_id` — Get tenant

#### Purpose
Returns one tenant the caller belongs to, including member count and the caller's role.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: any member of the tenant
- Non-members and deleted tenants get 404 so tenant IDs cannot be probed.

#### Prerequisites
- A `tenantId` collection variable (from **Create tenant** or **List my tenants**).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Tenant found.

  ```json
  {
    "message": "Tenant retrieved successfully.",
    "data": {
      "id": 4,
      "name": "Acme Coffee",
      "slug": "acme-coffee",
      "status": "active",
      "membershipRole": "owner",
      "joinedAt": "2026-10-20T09:00:00.000Z",
      "memberCount": 1,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Non-numeric or non-positive ID.

  ```json
  {
    "error": {
      "code": "INVALID_TENANT_ID",
      "message": "A valid tenant ID is required."
    }
  }
  ```
- **404 Not Found**: Not a member, or tenant deleted or nonexistent.

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/tenants/:tenant_id/members` — List members

#### Purpose
Lists a tenant's members ordered owner, admin, member. Always paginated (default `limit=20`, `offset=0`).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: any member of the tenant

#### Prerequisites
- A `tenantId` variable.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Page of members.

  ```json
  {
    "message": "Tenant members retrieved successfully.",
    "data": [
      {
        "userId": 12,
        "username": "janedoe",
        "email": "jane@example.com",
        "membershipRole": "owner",
        "joinedAt": "2026-10-20T09:00:00.000Z",
        "accountStatus": "active"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```
- **404 Not Found**: Not a member.

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/tenants/:tenant_id/members/:user_id` — Get member

#### Purpose
Returns one member of a tenant with the account status (`active`, `disabled` or `deleted`).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: any member of the tenant

#### Prerequisites
- `tenantId` and `memberUserId` variables.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `user_id` | path | positive integer | User ID of the member. | `{{memberUserId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Member found.

  ```json
  {
    "message": "Tenant member retrieved successfully.",
    "data": {
      "userId": 12,
      "username": "janedoe",
      "email": "jane@example.com",
      "membershipRole": "owner",
      "joinedAt": "2026-10-20T09:00:00.000Z",
      "accountStatus": "active"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Malformed user ID.

  ```json
  {
    "error": {
      "code": "INVALID_USER_ID",
      "message": "A valid user ID is required."
    }
  }
  ```
- **404 Not Found**: Not a member of this tenant.

  ```json
  {
    "error": {
      "code": "MEMBER_NOT_FOUND",
      "message": "Member not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/tenants/:tenant_id/members` — Add member

#### Purpose
Adds an existing, enabled account to the tenant by email or username.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin (re-checked under a tenant lock). Admins may add only plain `member`s; granting `admin`/`owner` needs an owner.
- Tenant must be active.

#### Prerequisites
- `tenantId`; set `inviteEmail` in your environment to the account being added.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | exactly one of email / username | Existing active account email (case-insensitive). |
| `username` | string | exactly one of email / username | Existing active account username, 3-20 alphanumeric. |
| `role` | string | no | `owner`, `admin` or `member` (default `member`). |

Valid example:
```json
{
  "email": "{{inviteEmail}}",
  "role": "member"
}
```

Invalid example (400: Exactly one identifier and a valid role are required (`INVALID_MEMBER`).):
```json
{
  "email": "a@example.com",
  "username": "both",
  "role": "god"
}
```

#### Expected responses
- **201 Created**: Member added.

  ```json
  {
    "message": "Member added.",
    "data": {
      "userId": 12,
      "username": "janedoe",
      "email": "jane@example.com",
      "membershipRole": "member",
      "joinedAt": "2026-10-20T09:00:00.000Z",
      "accountStatus": "active"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "INVALID_MEMBER",
      "message": "Provide exactly one of email or username for an existing account, and an optional role (owner, admin, member)."
    }
  }
  ```
- **403 Forbidden**: Plain members cannot add; `OWNER_REQUIRED` when an admin tries to grant owner/admin.

  ```json
  {
    "error": {
      "code": "TENANT_ROLE_REQUIRED",
      "message": "Only tenant owners and admins can add members."
    }
  }
  ```
- **404 Not Found**: Also `TENANT_NOT_FOUND` for non-members.

  ```json
  {
    "error": {
      "code": "USER_NOT_FOUND",
      "message": "No active account matches that identifier."
    }
  }
  ```
- **409 Conflict**: Also `TENANT_INACTIVE`.

  ```json
  {
    "error": {
      "code": "ALREADY_MEMBER",
      "message": "That account is already a member of this tenant."
    }
  }
  ```

#### Side effects
- Inserts a `tenant_members` row.
- Writes an `ADD TENANT MEMBER` audit entry in the same transaction.
- Audit: `ADD TENANT MEMBER` (table `tenant_members`, tenant-scoped).

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a second call returns 409 `ALREADY_MEMBER`.

### PATCH `/tenants/:tenant_id/members/:user_id` — Change member role

#### Purpose
Changes a member's tenant role. Owner-only; nobody can change their own role; a tenant always keeps one owner.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner
- Tenant must be active.

#### Prerequisites
- `tenantId` and `memberUserId` for someone other than the caller.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `user_id` | path | positive integer | Member whose role changes (not yourself). | `{{memberUserId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `role` | string | yes | `owner`, `admin` or `member`. No other keys are accepted. |

Valid example:
```json
{
  "role": "admin"
}
```

Invalid example (400: `INVALID_ROLE_CHANGE`.):
```json
{
  "role": "superuser"
}
```

#### Expected responses
- **200 OK**: `Member role updated.` or `Role unchanged.`

  ```json
  {
    "message": "Member role updated.",
    "data": {
      "userId": 12,
      "username": "janedoe",
      "email": "jane@example.com",
      "membershipRole": "admin",
      "joinedAt": "2026-10-20T09:00:00.000Z",
      "accountStatus": "active"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "INVALID_ROLE_CHANGE",
      "message": "Provide a valid user ID and a role (owner, admin, member)."
    }
  }
  ```
- **403 Forbidden**: Also `CANNOT_CHANGE_OWN_ROLE`.

  ```json
  {
    "error": {
      "code": "OWNER_REQUIRED",
      "message": "Only tenant owners can change member roles."
    }
  }
  ```
- **404 Not Found**: Target is not a member.

  ```json
  {
    "error": {
      "code": "MEMBER_NOT_FOUND",
      "message": "Member not found."
    }
  }
  ```
- **409 Conflict**: Also `TENANT_INACTIVE`.

  ```json
  {
    "error": {
      "code": "LAST_OWNER",
      "message": "A tenant must keep at least one owner. Promote another owner first."
    }
  }
  ```

#### Side effects
- Updates `tenant_members.membership_role`.
- Writes `UPDATE TENANT MEMBER ROLE` (old and new role) when the role actually changes.
- Audit: `UPDATE TENANT MEMBER ROLE` (table `tenant_members`, tenant-scoped); none for an unchanged role.

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: repeating the same role returns `Role unchanged.` with no audit entry.

### DELETE `/tenants/:tenant_id/members/:user_id` — Remove member / leave tenant

#### Purpose
Removes a member, or lets the caller leave by passing their own user ID.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner/admin to remove others (admins only plain members); any member may remove themself.
- The last owner cannot be removed.

#### Prerequisites
- `tenantId` and `memberUserId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `user_id` | path | positive integer | Member to remove. | `{{memberUserId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Removed (or left).

  ```json
  {
    "message": "Member removed.",
    "data": {
      "userId": 15,
      "removed": true
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Malformed ID.

  ```json
  {
    "error": {
      "code": "INVALID_USER_ID",
      "message": "A valid user ID is required."
    }
  }
  ```
- **403 Forbidden**: Also `OWNER_REQUIRED`.

  ```json
  {
    "error": {
      "code": "TENANT_ROLE_REQUIRED",
      "message": "Only tenant owners and admins can remove members."
    }
  }
  ```
- **404 Not Found**: Not a member.

  ```json
  {
    "error": {
      "code": "MEMBER_NOT_FOUND",
      "message": "Member not found."
    }
  }
  ```
- **409 Conflict**: Also `MEMBER_HAS_LINKED_RECORDS`, `TENANT_INACTIVE`.

  ```json
  {
    "error": {
      "code": "LAST_OWNER",
      "message": "A tenant must keep at least one owner. Transfer ownership first."
    }
  }
  ```

#### Side effects
- Deletes the `tenant_members` row.
- Writes a `REMOVE TENANT MEMBER` audit entry.
- Audit: `REMOVE TENANT MEMBER` (table `tenant_members`, tenant-scoped).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: the second call returns 404 `MEMBER_NOT_FOUND`.

### GET `/tenants/:tenant_id/invitations` — List invitations

#### Purpose
Lists the organization's invitations, newest first (paginated). `expired` is derived from the expiry time.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Re-checked inside the transaction under a tenant lock.

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `status` | query | enum | `pending` (default), `expired`, `accepted`, `revoked` or `all`. | `pending` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Page of invitations.

  ```json
  {
    "message": "Invitations retrieved successfully.",
    "data": [
      {
        "id": "5",
        "email": "sam@example.com",
        "role": "member",
        "status": "pending",
        "expiresAt": "2026-11-05T09:00:00.000Z",
        "createdAt": "2026-10-29T09:00:00.000Z",
        "invitedByUserId": "12"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```
- **400 Bad Request**: Bad `status`.

  ```json
  {
    "error": {
      "code": "INVALID_FILTER",
      "message": "Unknown status filter.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Plain member.

  ```json
  {
    "error": {
      "code": "TENANT_ROLE_REQUIRED",
      "message": "This action requires one of these tenant roles: owner, admin."
    }
  }
  ```
- **404 Not Found**: Not a member.

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/tenants/:tenant_id/invitations` — Invite a teammate

#### Purpose
Invites an email address to the organization. Only an account that has verified that exact address can accept. A new invitation replaces an older pending one for the same address. The email contains a link with a 256-bit token (stored only as a hash).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin; admins may invite only `member`; owners any role
- Re-checked inside the transaction under a tenant lock.

#### Prerequisites
- `tenantId`; `invitationEmail` variable. Rate limited to 60 per hour per user.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | Valid email; not your own; not already a member. |
| `role` | string | no | `member` (default), `admin` or `owner` (owners only for admin/owner). |

Valid example:
```json
{
  "email": "{{invitationEmail}}",
  "role": "member"
}
```

Invalid example (400: `INVALID_INVITATION`.):
```json
{
  "email": "x",
  "role": "god"
}
```

#### Expected responses
- **201 Created**: Created and emailed (valid 7 days).

  ```json
  {
    "message": "Invitation sent.",
    "data": {
      "id": "5",
      "email": "sam@example.com",
      "role": "member",
      "status": "pending",
      "expiresAt": "2026-11-05T09:00:00.000Z",
      "createdAt": "2026-10-29T09:00:00.000Z",
      "invitedByUserId": "12"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Validation or self-invite.

  ```json
  {
    "error": {
      "code": "INVALID_INVITATION",
      "message": "Provide a valid email address and an optional role (owner, admin, member).",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Also `TENANT_ROLE_REQUIRED`.

  ```json
  {
    "error": {
      "code": "OWNER_REQUIRED",
      "message": "Only tenant owners can invite someone as an owner or administrator."
    }
  }
  ```
- **404 Not Found**: Not a member.

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```
- **409 Conflict**: Also `INVITATION_LIMIT` (100 pending), `TENANT_INACTIVE`.

  ```json
  {
    "error": {
      "code": "ALREADY_MEMBER",
      "message": "That person is already a member of this organization."
    }
  }
  ```
- **429 Too Many Requests**: Hourly cap.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many invitations sent. Try again later."
    }
  }
  ```

#### Side effects
- Revokes a previous pending invitation for the address, inserts the new one, emails it (after commit).
- Audit: `CREATE INVITATION` (tenant-scoped, masked email, no token).

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: re-inviting replaces the pending invitation.

### POST `/tenants/:tenant_id/invitations/:invitation_id/resend` — Resend invitation

#### Purpose
Issues a new token and a fresh 7-day expiry for a pending invitation and emails it; the previous link stops working.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Re-checked inside the transaction under a tenant lock.

#### Prerequisites
- `invitationId` of a pending invitation.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `invitation_id` | path | positive integer | Invitation ID within the tenant. | `{{invitationId}}` |

#### Request body
No request body.

#### Expected responses
- **200 OK**: Resent.

  ```json
  {
    "message": "Invitation resent.",
    "data": {
      "id": "5",
      "email": "sam@example.com",
      "role": "member",
      "status": "pending",
      "expiresAt": "2026-11-05T09:00:00.000Z",
      "createdAt": "2026-10-29T09:00:00.000Z",
      "invitedByUserId": "12"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: Admin touching an admin/owner invitation.

  ```json
  {
    "error": {
      "code": "OWNER_REQUIRED",
      "message": "Only tenant owners can manage this invitation."
    }
  }
  ```
- **404 Not Found**: No such invitation in this tenant.

  ```json
  {
    "error": {
      "code": "INVITATION_NOT_FOUND",
      "message": "Invitation not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Already accepted/revoked/expired.

  ```json
  {
    "error": {
      "code": "INVITATION_NOT_PENDING",
      "message": "Only pending invitations can be resent."
    }
  }
  ```
- **429 Too Many Requests**: 60-second cooldown.

  ```json
  {
    "error": {
      "code": "RESEND_COOLDOWN",
      "message": "This invitation was just sent. Wait a moment before resending."
    }
  }
  ```

#### Side effects
- Replaces the token hash and expiry; emails the new link.
- Audit: `RESEND INVITATION`.

#### Testing notes
- Asserts status 200 or 409 or 429 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes after the cooldown.

### DELETE `/tenants/:tenant_id/invitations/:invitation_id` — Revoke invitation

#### Purpose
Cancels a pending invitation; its link stops working immediately.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Re-checked inside the transaction under a tenant lock.

#### Prerequisites
- `invitationId` of a pending invitation.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `invitation_id` | path | positive integer | Invitation ID within the tenant. | `{{invitationId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Revoked.

  ```json
  {
    "message": "Invitation revoked.",
    "data": {
      "id": "5",
      "status": "revoked"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: Admin touching an admin/owner invitation.

  ```json
  {
    "error": {
      "code": "OWNER_REQUIRED",
      "message": "Only tenant owners can manage this invitation."
    }
  }
  ```
- **404 Not Found**: No such invitation in this tenant.

  ```json
  {
    "error": {
      "code": "INVITATION_NOT_FOUND",
      "message": "Invitation not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Not pending.

  ```json
  {
    "error": {
      "code": "INVITATION_NOT_PENDING",
      "message": "Only pending invitations can be revoked."
    }
  }
  ```

#### Side effects
- Sets status `revoked`.
- Audit: `REVOKE INVITATION`.

#### Testing notes
- Asserts status 200 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a second call returns 409.

### POST `/tenants/:tenant_id/ownership-transfer/request` — Request ownership transfer

#### Purpose
First step of handing the organization to another member: emails the current owner a confirmation code (step-up). Nothing changes yet.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner
- Tenant must be active.

#### Prerequisites
- `tenantId`; `newOwnerUserId` of an active member other than yourself.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `newOwnerUserId` | ID | yes | An active member of this tenant; no other keys. |

Valid example:
```json
{
  "newOwnerUserId": "{{newOwnerUserId}}"
}
```

Invalid example (400: `INVALID_TRANSFER`.):
```json
{}
```

#### Expected responses
- **202 Accepted**: Code emailed to the owner.

  ```json
  {
    "status": "code_sent",
    "codeLength": 6,
    "retryAfterSeconds": 60,
    "message": "We emailed you a confirmation code. Enter it to complete the transfer."
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Validation or self-transfer.

  ```json
  {
    "error": {
      "code": "INVALID_TRANSFER",
      "message": "Provide the user ID of an existing member as newOwnerUserId.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Not an owner.

  ```json
  {
    "error": {
      "code": "OWNER_REQUIRED",
      "message": "Only tenant owners can transfer ownership."
    }
  }
  ```
- **404 Not Found**: Target not an active member.

  ```json
  {
    "error": {
      "code": "MEMBER_NOT_FOUND",
      "message": "The new owner must be an active member of this organization.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Cooldown (has `Retry-After`).

  ```json
  {
    "error": {
      "code": "OTP_RATE_LIMITED",
      "message": "A code was just sent. Wait a moment before requesting another.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Issues a hashed `sensitive_action` challenge bound to this tenant and target; emails the code.
- Audit: `OWNERSHIP_TRANSFER_REQUESTED`.

#### Testing notes
- Asserts status 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (cooldown; supersedes the previous code).

### POST `/tenants/:tenant_id/ownership-transfer/confirm` — Confirm ownership transfer

#### Purpose
Completes the transfer with the emailed code: in one transaction the new owner becomes `owner` and the caller becomes `admin`. A code issued for another tenant or action is rejected.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner
- Re-checked under the tenant lock.

#### Prerequisites
- `transferCode` from the email.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `code` | string | yes | 6 digits. |

Valid example:
```json
{
  "code": "{{transferCode}}"
}
```

#### Expected responses
- **200 OK**: Transferred.

  ```json
  {
    "message": "Ownership transferred. You are now an administrator of this organization.",
    "data": {
      "tenantId": "4",
      "newOwnerUserId": "15",
      "yourRole": "admin"
    }
  }
  ```
- **400 Bad Request**: Wrong code. Also `OTP_EXPIRED`, `OTP_LOCKED` (5 wrong attempts: request a new code) and `OTP_ALREADY_USED` (sign-in challenge already completed).

  ```json
  {
    "error": {
      "code": "OTP_INVALID",
      "message": "That code is not correct.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: Not (or no longer) an owner.

  ```json
  {
    "error": {
      "code": "OWNER_REQUIRED",
      "message": "Only tenant owners can transfer ownership."
    }
  }
  ```
- **409 Conflict**: Target left meanwhile.

  ```json
  {
    "error": {
      "code": "MEMBER_NOT_FOUND",
      "message": "The new owner is no longer an active member of this organization.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Promotes the target, demotes the caller, consumes the code; exactly one owner remains.
- Audit: `OWNERSHIP_TRANSFERRED` (tenant-scoped, old and new owner).

#### Testing notes
- Asserts status 200 or 400 or 403 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: single use, and the caller is no longer an owner afterwards.

## Invitations

### POST `/invitations/preview` — Preview invitation (token)

#### Purpose
Shows what an invitation token is for before the person signs in (organization, role, inviter, masked address, expiry). Public: the 256-bit token is the credential. Reveals nothing else.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public. 30 requests per 15 minutes per IP.

#### Prerequisites
- `invitationToken` from the `#token=` fragment of the emailed link.

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `token` | string | yes | From the link (sent in the body, never in a URL). |

Valid example:
```json
{
  "token": "{{invitationToken}}"
}
```

Invalid example (400: `INVALID_INVITATION`.):
```json
{
  "token": "x"
}
```

#### Expected responses
- **200 OK**: Valid, pending, unexpired invitation to an active organization. `Cache-Control: no-store`.

  ```json
  {
    "data": {
      "organization": "Acme Coffee",
      "role": "member",
      "invitedBy": "Jane Doe",
      "emailHint": "s***@example.com",
      "expiresAt": "2026-11-05T09:00:00.000Z"
    }
  }
  ```
- **400 Bad Request**: Unknown, used, expired or revoked (indistinguishable).

  ```json
  {
    "error": {
      "code": "INVALID_INVITATION",
      "message": "This invitation is invalid, expired, or was already used.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **429 Too Many Requests**: Per-IP rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many attempts. Try again later."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 or 400 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes.

### GET `/invitations/mine` — My pending invitations

#### Purpose
Pending, unexpired invitations addressed to the signed-in user's verified email address (for the onboarding screen).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable

#### Prerequisites
- Signed in.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Possibly empty.

  ```json
  {
    "message": "Invitations retrieved successfully.",
    "data": [
      {
        "id": "5",
        "organization": "Acme Coffee",
        "role": "member",
        "invitedBy": "Jane Doe",
        "expiresAt": "2026-11-05T09:00:00.000Z"
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/invitations/accept` — Accept invitation (token)

#### Purpose
Accepts an invitation using the token from the emailed link. The signed-in account must be verified and its email must equal the invited address. The membership is created and the token consumed in one transaction; concurrent attempts create one membership.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable
- 20 requests per 15 minutes per user.

#### Prerequisites
- `invitationToken` from the `#token=` fragment of the link.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
None.

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `token` | string | yes | From the link (sent in the body, never in a URL). |

Valid example:
```json
{
  "token": "{{invitationToken}}"
}
```

Invalid example (400: `INVALID_INVITATION`.):
```json
{
  "token": "x"
}
```

#### Expected responses
- **200 OK**: Joined (or already a member, which closes the invitation).

  ```json
  {
    "message": "Invitation accepted.",
    "data": {
      "tenantId": "4",
      "name": "Acme Coffee",
      "membershipRole": "member",
      "alreadyMember": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Unknown, used, revoked or deleted-tenant invitation.

  ```json
  {
    "error": {
      "code": "INVALID_INVITATION",
      "message": "This invitation is invalid, expired, or was already used.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Wrong account.

  ```json
  {
    "error": {
      "code": "INVITATION_EMAIL_MISMATCH",
      "message": "This invitation was sent to a different email address. Sign in with that address to accept it.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Inviter lost authority. Also `TENANT_INACTIVE`.

  ```json
  {
    "error": {
      "code": "INVITATION_NO_LONGER_VALID",
      "message": "The person who invited you can no longer add members. Ask for a new invitation.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **410 **: Past the 7-day expiry.

  ```json
  {
    "error": {
      "code": "INVITATION_EXPIRED",
      "message": "This invitation has expired. Ask for a new one.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Inserts `tenant_members`, marks the invitation accepted (after re-checking inviter authority and tenant status under a tenant lock).
- Audit: `ADD TENANT MEMBER` (via invitation) and `ACCEPT INVITATION` (tenant-scoped).

#### Testing notes
- Asserts status 200 or 400 or 403 or 409 or 410 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: single use.

### POST `/invitations/:invitation_id/accept` — Accept invitation (from my list)

#### Purpose
Accepts one of the invitations from **My pending invitations** without the email token. The same email-match, authority and transaction rules apply.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: not applicable
- 20 requests per 15 minutes per user.

#### Prerequisites
- `invitationId` from **My pending invitations**.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `invitation_id` | path | positive integer | Invitation ID within the tenant. | `{{invitationId}}` |

#### Request body
No request body.

#### Expected responses
- **200 OK**: Joined.

  ```json
  {
    "message": "Invitation accepted.",
    "data": {
      "tenantId": "4",
      "name": "Acme Coffee",
      "membershipRole": "member",
      "alreadyMember": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **400 Bad Request**: Not addressed to this account, used or revoked (indistinguishable).

  ```json
  {
    "error": {
      "code": "INVALID_INVITATION",
      "message": "This invitation is invalid, expired, or was already used.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Also `TENANT_INACTIVE`.

  ```json
  {
    "error": {
      "code": "INVITATION_NO_LONGER_VALID",
      "message": "The person who invited you can no longer add members. Ask for a new invitation.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **410 **: Expired.

  ```json
  {
    "error": {
      "code": "INVITATION_EXPIRED",
      "message": "This invitation has expired. Ask for a new one.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Same as **Accept invitation (token)**.
- Audit: `ADD TENANT MEMBER`, `ACCEPT INVITATION`.

#### Testing notes
- Asserts status 200 or 400 or 409 or 410 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: single use.

## Inventory

### GET `/inventory/health/` — Inventory route check

#### Purpose
Pre-existing smoke check that the inventory router is mounted. It does not touch the database; use `/health/ready` for real readiness.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- Public.

#### Prerequisites
- None.

#### Headers
- `Cookie: bean.sid=...`: not used.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
None.

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Router mounted.

  ```json
  {
    "message": "Inventory route is working!"
  }
  ```

#### Side effects
- None.
- Audit: None.

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/inventory/tenants/:tenant_id/items` — List inventory items

#### Purpose
Lists a tenant's inventory newest first. Without paging parameters every row is returned; with any of `page`/`limit`/`offset` the response is paginated.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INVENTORY_READ`
- Tenant membership/role: any member of the tenant

#### Prerequisites
- `tenantId` variable; account role with `INVENTORY_READ`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Items (empty array and `No inventory data found.` when none).

  ```json
  {
    "message": "Inventory data retrieved successfully.",
    "data": [
      {
        "id": 31,
        "name": "Bean bag",
        "sku": "BEAN-42",
        "quantity": 10,
        "unit": "unit",
        "createdAt": "2026-10-20T09:00:00.000Z",
        "updatedAt": "2026-10-20T09:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```
- **404 Not Found**: Not a member of that tenant (other tenants' items are never visible).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```

#### Side effects
- Writes a best-effort `READ INVENTORY` audit entry (a failed audit write does not fail the read).
- Audit: `READ INVENTORY` (table `inventory`, tenant-scoped, best effort).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: only a best-effort audit row.
- Safe to repeat: Yes (each call adds one audit row).

### POST `/inventory/tenants/:tenant_id/items` — Create inventory item

#### Purpose
Creates an inventory item in the tenant. SKUs are unique per tenant.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INVENTORY_CREATE`
- Tenant membership/role: any member of an active tenant
- 409 `TENANT_INACTIVE` if the tenant is not active.

#### Prerequisites
- `tenantId` variable; role with `INVENTORY_CREATE`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 3-50 characters; letters and digits with single spaces. |
| `sku` | string | yes | 3-20 characters; letters, digits, single hyphens. Upper-cased. Unique per tenant. |
| `quantity` | integer | no | 0 to 2147483647 (default 0). Digit strings are accepted. |
| `unit` | string | no | 1-50 characters (default `unit`). |

Valid example:
```json
{
  "name": "Bean bag",
  "sku": "{{itemSku}}",
  "quantity": 10,
  "unit": "unit"
}
```

Invalid example (400: First failing rule is reported.):
```json
{
  "name": "a",
  "sku": "bad sku",
  "quantity": -1
}
```

#### Expected responses
- **200 OK**: Created. (The implementation returns 200, not 201.)

  ```json
  {
    "message": "Inventory data inserted successfully.",
    "data": {
      "id": 31,
      "name": "Bean bag",
      "sku": "BEAN-42",
      "quantity": 10,
      "unit": "unit",
      "createdAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **400 Bad Request**: Validation failure (name, sku, quantity, unit messages).

  ```json
  {
    "message": "SKU must be 3 to 20 characters using letters, numbers, and hyphens."
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **409 Conflict**: Duplicate SKU within the tenant.

  ```json
  {
    "message": "An inventory item with this SKU already exists."
  }
  ```

#### Side effects
- Inserts an `inventory` row.
- Writes a `CREATE INVENTORY` audit entry in the same transaction.
- Audit: `CREATE INVENTORY` (table `inventory`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No with a fixed SKU (409); the pre-request script generates a fresh SKU each run.

### PUT `/inventory/tenants/:tenant_id/items/:id` — Update inventory item

#### Purpose
Replaces name, SKU, quantity and unit of an existing item (full replacement, not a patch).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INVENTORY_UPDATE`
- Tenant membership/role: any member of an active tenant
- Items of other tenants behave as missing (404).

#### Prerequisites
- `tenantId` and `itemId` (run **Create inventory item**).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `id` | path | positive integer | Inventory item ID within the tenant. | `{{itemId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | As in create. |
| `sku` | string | yes | As in create. |
| `quantity` | integer | yes | 0 to 2147483647. |
| `unit` | string | yes | 1-50 characters. |

Valid example:
```json
{
  "name": "Bean bag",
  "sku": "{{itemSku}}",
  "quantity": 25,
  "unit": "unit"
}
```

Invalid example (400: All four fields are required on update.):
```json
{
  "name": "Bean bag"
}
```

#### Expected responses
- **200 OK**: Updated.

  ```json
  {
    "message": "Inventory item updated successfully.",
    "data": {
      "id": 31,
      "name": "Bean bag",
      "sku": "BEAN-42",
      "quantity": 25,
      "unit": "unit",
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **400 Bad Request**: Malformed ID or field validation message.

  ```json
  {
    "message": "Invalid inventory item ID."
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **404 Not Found**: Missing or belongs to another tenant.

  ```json
  {
    "message": "Inventory item not found."
  }
  ```
- **409 Conflict**: SKU collision.

  ```json
  {
    "message": "Another inventory item already uses this SKU."
  }
  ```

#### Side effects
- Updates the row under a row lock.
- Writes `UPDATE INVENTORY` (old and new rows) in the same transaction.
- Audit: `UPDATE INVENTORY` (table `inventory`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: same payload gives the same state (each call adds an audit row).

## Audit

### GET `/audit/all` — Platform audit log (all tenants)

#### Purpose
Global, cross-tenant audit history, newest first. For platform operators only.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `PLATFORM_AUDIT_READ`
- Tenant membership/role: not applicable
- Granted to no role by default; assign it explicitly to operators.

#### Prerequisites
- An operator account holding `PLATFORM_AUDIT_READ`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Entries (unpaginated when no paging parameter is sent).

  ```json
  {
    "message": "Audit logs retrieved successfully.",
    "data": [
      {
        "id": 501,
        "userId": 12,
        "tenantId": 4,
        "action": "CREATE INVENTORY",
        "tableName": "inventory",
        "recordId": 31,
        "oldData": null,
        "newData": {
          "id": 31,
          "sku": "BEAN-42"
        },
        "createdAt": "2026-10-20T09:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/audit/tenants/:tenant_id` — Tenant audit log

#### Purpose
One tenant's audit history. Only rows whose `tenant_id` matches are returned (rows, count and pagination alike).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `AUDIT_READ`
- Tenant membership/role: owner or admin of the tenant
- Non-members get 404; plain members get 403.

#### Prerequisites
- `tenantId`; role with `AUDIT_READ` and an owner/admin membership.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Entries for this tenant.

  ```json
  {
    "message": "Audit logs retrieved successfully.",
    "data": [
      {
        "id": 501,
        "userId": 12,
        "tenantId": 4,
        "action": "CREATE INVENTORY",
        "tableName": "inventory",
        "recordId": 31,
        "oldData": null,
        "newData": {
          "id": 31,
          "sku": "BEAN-42"
        },
        "createdAt": "2026-10-20T09:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```
- **403 Forbidden**: Plain member.

  ```json
  {
    "error": {
      "code": "TENANT_ROLE_REQUIRED",
      "message": "This action requires one of these tenant roles: owner, admin."
    }
  }
  ```
- **404 Not Found**: Not a member.

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

## Integrations

### GET `/integrations/all/:tenant_id` — List tenant integrations

#### Purpose
Lists the integrated apps registered for a tenant, newest first. Credentials are never returned.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of the tenant
- Membership is enforced by the query: a non-member receives an empty list (200), not an error.

#### Prerequisites
- `tenantId`; role with `INTEGRATIONS_READ`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Apps (empty array and `No integrations found for tenant.` when none or not a member).

  ```json
  {
    "data": [
      {
        "id": 9,
        "tenantId": 4,
        "name": "Acme storefront",
        "description": null,
        "status": "active",
        "createdByUserId": 12,
        "lastEventAt": null,
        "createdAt": "2026-10-20T09:00:00.000Z",
        "updatedAt": "2026-10-20T09:00:00.000Z",
        "appUrl": "https://store.example.com",
        "webhookUrl": null
      }
    ],
    "message": "Tenant integrations retrieved successfully.",
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```
- **400 Bad Request**: Malformed tenant ID.

  ```json
  {
    "message": "A valid tenant_id is required."
  }
  ```

#### Side effects
- Best-effort `GET TENANT INTEGRATIONS` audit entry when at least one row is returned.
- Audit: `GET TENANT INTEGRATIONS` (best effort, tenant-scoped).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: only a best-effort audit row.
- Safe to repeat: Yes (adds an audit row each time rows are returned).

### POST `/integrations/tenants/:tenant_id/apps` — Register integration

#### Purpose
Registers an integrated app in `pending` status and issues its one-time credential (bearer secret). Store the secret immediately: only a bcrypt hash is kept.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)
- Tenant must be active. Rate limited to 20 registrations per hour per user.

#### Prerequisites
- `tenantId`; role with `INTEGRATIONS_MANAGE` and owner/admin membership.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1-255 characters. |
| `description` | string | no | 0-2000 characters. |
| `appUrl` | string (http/https URL) | no | Max 2048 characters, no embedded credentials. |
| `webhookUrl` | string (http/https URL) | no | As `appUrl`. |

Valid example:
```json
{
  "name": "Acme storefront",
  "description": "Online store",
  "appUrl": "https://store.example.com"
}
```

Invalid example (400: `INVALID_INTEGRATION`: empty name, non-http URL or unknown keys.):
```json
{
  "name": "",
  "appUrl": "ftp://x",
  "admin": true
}
```

#### Expected responses
- **201 Created**: Registered. `credential` appears only in this response.

  ```json
  {
    "message": "Integration registered. Store this credential now; it will not be shown again.",
    "data": {
      "id": 9,
      "tenantId": 4,
      "name": "Acme storefront",
      "description": null,
      "appKey": "bean_Qx3-example",
      "status": "pending",
      "appUrl": "https://store.example.com",
      "webhookUrl": null,
      "lastEventAt": null,
      "credentialConfigured": true,
      "credentialRotatedAt": "2026-10-20T09:00:00.000Z",
      "createdByUserId": 12,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z",
      "credential": "<one-time secret>"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "INVALID_INTEGRATION",
      "message": "Provide a name (1-255 characters) and optional description, appUrl and webhookUrl (http/https)."
    }
  }
  ```
- **403 Forbidden**: Caller is a plain member of the owning tenant.

  ```json
  {
    "error": {
      "code": "TENANT_ADMIN_REQUIRED",
      "message": "Tenant administrator access is required."
    }
  }
  ```
- **404 Not Found**: Not a member.

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found."
    }
  }
  ```
- **409 Conflict**: Tenant not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "Integrations can only be registered for an active tenant."
    }
  }
  ```
- **429 Too Many Requests**: Per-user hourly limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many integration registration requests."
    }
  }
  ```

#### Side effects
- Inserts `integrated_apps` (status `pending`, hashed credential).
- Writes an `integration_lifecycle_activity` row and a `CREATE INTEGRATION` audit entry in one transaction.
- Audit: `CREATE INTEGRATION` (table `integrated_apps`, tenant-scoped, transactional) plus lifecycle activity `integration.created`.

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Not idempotent: every call creates another app and credential.
- The pre-request/test scripts save the one-time secret to the collection variable `integrationCredential` and the key to `integrationAppKey`. Both are session-only values: do not export or commit a collection run that holds them.

### GET `/integrations/:integration_id` — Get integration

#### Purpose
Returns one integration with its event subscriptions and an activation-readiness report.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of the tenant

#### Prerequisites
- `integrationId` variable.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Found.

  ```json
  {
    "message": "Integration retrieved successfully.",
    "data": {
      "id": 9,
      "tenantId": 4,
      "name": "Acme storefront",
      "description": null,
      "appKey": "bean_Qx3-example",
      "status": "pending",
      "appUrl": "https://store.example.com",
      "webhookUrl": null,
      "lastEventAt": null,
      "credentialConfigured": true,
      "credentialRotatedAt": "2026-10-20T09:00:00.000Z",
      "createdByUserId": 12,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z",
      "subscriptions": [
        {
          "eventType": "transaction.completed",
          "enabled": true
        }
      ],
      "readiness": {
        "ready": true,
        "checks": {
          "tenantActive": true,
          "credentialConfigured": true,
          "supportedSubscriptionEnabled": true
        }
      }
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID.

  ```json
  {
    "error": {
      "code": "INVALID_INTEGRATION_ID",
      "message": "A valid integration ID is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### PUT `/integrations/:integration_id/subscriptions` — Set event subscriptions

#### Purpose
Replaces the set of enabled event types for the integration (listed types are enabled, all others disabled).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)

#### Prerequisites
- `integrationId`; integration not disconnected.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `eventTypes` | string[] | yes | Up to 50 distinct, registered, active event types with a supported handler (e.g. `transaction.completed`, `inventory.adjusted`). No other keys. |

Valid example:
```json
{
  "eventTypes": [
    "transaction.completed",
    "inventory.adjusted"
  ]
}
```

Invalid example (422: `UNSUPPORTED_EVENT_TYPES` lists the offending types.):
```json
{
  "eventTypes": [
    "made.up"
  ]
}
```

#### Expected responses
- **200 OK**: Updated.

  ```json
  {
    "message": "Subscriptions updated.",
    "data": {
      "integrationId": 9,
      "enabledEventTypes": [
        "transaction.completed",
        "inventory.adjusted"
      ]
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "INVALID_SUBSCRIPTIONS",
      "message": "Provide eventTypes as a list of distinct registered event types."
    }
  }
  ```
- **403 Forbidden**: Caller is a plain member of the owning tenant.

  ```json
  {
    "error": {
      "code": "TENANT_ADMIN_REQUIRED",
      "message": "Tenant administrator access is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```
- **409 Conflict**: Integration was disconnected.

  ```json
  {
    "error": {
      "code": "INTEGRATION_REVOKED",
      "message": "A disconnected integration cannot be configured."
    }
  }
  ```
- **422 Unprocessable Entity**: Unregistered or unsupported event types.

  ```json
  {
    "error": {
      "code": "UNSUPPORTED_EVENT_TYPES",
      "message": "These event types are not registered with a supported handler.",
      "eventTypes": [
        "made.up"
      ]
    }
  }
  ```

#### Side effects
- Updates `integrated_app_event_subscriptions`.
- Writes lifecycle activity `subscriptions.updated` and an `UPDATE INTEGRATION SUBSCRIPTIONS` audit entry.
- Audit: `UPDATE INTEGRATION SUBSCRIPTIONS` (tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: same list yields the same state (each call adds audit/lifecycle rows).

### PUT `/integrations/:integration_id/user-mappings` — Map external user

#### Purpose
Creates or updates the mapping from an external app user ID to a tenant member, used to attribute sales and commissions.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)

#### Prerequisites
- `integrationId`; `currentUserId` (or any tenant member's user ID).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `externalUserId` | string | yes | 1-255 characters. |
| `userId` | integer | yes | Positive integer; must be a member of the integration's tenant (JSON number, not a string). |
| `isActive` | boolean | no | Default true. |

Valid example:
```json
{
  "externalUserId": "cashier-17",
  "userId": {{currentUserId}},
  "isActive": true
}
```

Invalid example (400: `userId` must be a JSON integer.):
```json
{
  "externalUserId": "x",
  "userId": "12"
}
```

#### Expected responses
- **200 OK**: Saved (upsert).

  ```json
  {
    "message": "User mapping saved.",
    "data": {
      "id": 3,
      "externalUserId": "cashier-17",
      "userId": 12,
      "isActive": true
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "INVALID_USER_MAPPING",
      "message": "Provide externalUserId, a numeric userId, and an optional boolean isActive."
    }
  }
  ```
- **403 Forbidden**: Caller is a plain member of the owning tenant.

  ```json
  {
    "error": {
      "code": "TENANT_ADMIN_REQUIRED",
      "message": "Tenant administrator access is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```
- **409 Conflict**: Disconnected.

  ```json
  {
    "error": {
      "code": "INTEGRATION_REVOKED",
      "message": "A disconnected integration cannot be configured."
    }
  }
  ```
- **422 Unprocessable Entity**: userId is not a member.

  ```json
  {
    "error": {
      "code": "USER_NOT_TENANT_MEMBER",
      "message": "The mapped user must be a member of this tenant."
    }
  }
  ```

#### Side effects
- Upserts `integration_user_mappings`.
- Writes lifecycle activity `user_mapping.updated` and an `UPDATE INTEGRATION USER MAPPING` audit entry.
- Audit: `UPDATE INTEGRATION USER MAPPING` (tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (upsert).

### POST `/integrations/:integration_id/activate` — Activate integration

#### Purpose
Moves the integration to `active` so it can deliver events. Requires readiness: tenant active, credential configured and at least one supported subscription enabled.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)

#### Prerequisites
- `integrationId`. Subscriptions must be set first (**Set event subscriptions**).
- Integration must currently be `pending` or `suspended`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
No request body. A non-empty JSON body is rejected with 400 `INVALID_REQUEST`.

#### Expected responses
- **200 OK**: Transitioned to `active`.

  ```json
  {
    "message": "Integration active.",
    "data": {
      "id": 9,
      "tenantId": 4,
      "name": "Acme storefront",
      "description": null,
      "appKey": "bean_Qx3-example",
      "status": "active",
      "appUrl": "https://store.example.com",
      "webhookUrl": null,
      "lastEventAt": null,
      "credentialConfigured": true,
      "credentialRotatedAt": "2026-10-20T09:00:00.000Z",
      "createdByUserId": 12,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID.

  ```json
  {
    "error": {
      "code": "INVALID_INTEGRATION_ID",
      "message": "A valid integration ID is required."
    }
  }
  ```
- **400 Bad Request**: Body supplied.

  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "This operation does not accept a request body."
    }
  }
  ```
- **403 Forbidden**: Caller is a plain member of the owning tenant.

  ```json
  {
    "error": {
      "code": "TENANT_ADMIN_REQUIRED",
      "message": "Tenant administrator access is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```
- **409 Conflict**: Current status does not allow this transition.

  ```json
  {
    "error": {
      "code": "INVALID_LIFECYCLE_TRANSITION",
      "message": "An integration in status revoked cannot be moved to active."
    }
  }
  ```
- **409 Conflict**: A readiness check failed; the refusal is recorded in lifecycle activity. The body also carries `error.checks`.

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_READY",
      "message": "The integration is not ready to activate."
    }
  }
  ```

#### Side effects
- Sets `integrated_apps.status` to `active`.
- Writes lifecycle activity and an `ACTIVATE INTEGRATION` audit entry (old and new status) in one transaction.
- Audit: `ACTIVATE INTEGRATION` (table `integrated_apps`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: repeating returns 409 `INVALID_LIFECYCLE_TRANSITION`.

### POST `/integrations/:integration_id/suspend` — Suspend integration

#### Purpose
Temporarily stops an active integration; its events are rejected with 401 until re-activated.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)

#### Prerequisites
- `integrationId`.
- Integration must currently be `active`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
No request body. A non-empty JSON body is rejected with 400 `INVALID_REQUEST`.

#### Expected responses
- **200 OK**: Transitioned to `suspended`.

  ```json
  {
    "message": "Integration suspended.",
    "data": {
      "id": 9,
      "tenantId": 4,
      "name": "Acme storefront",
      "description": null,
      "appKey": "bean_Qx3-example",
      "status": "suspended",
      "appUrl": "https://store.example.com",
      "webhookUrl": null,
      "lastEventAt": null,
      "credentialConfigured": true,
      "credentialRotatedAt": "2026-10-20T09:00:00.000Z",
      "createdByUserId": 12,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID.

  ```json
  {
    "error": {
      "code": "INVALID_INTEGRATION_ID",
      "message": "A valid integration ID is required."
    }
  }
  ```
- **400 Bad Request**: Body supplied.

  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "This operation does not accept a request body."
    }
  }
  ```
- **403 Forbidden**: Caller is a plain member of the owning tenant.

  ```json
  {
    "error": {
      "code": "TENANT_ADMIN_REQUIRED",
      "message": "Tenant administrator access is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```
- **409 Conflict**: Current status does not allow this transition.

  ```json
  {
    "error": {
      "code": "INVALID_LIFECYCLE_TRANSITION",
      "message": "An integration in status revoked cannot be moved to suspended."
    }
  }
  ```

#### Side effects
- Sets `integrated_apps.status` to `suspended`.
- Writes lifecycle activity and an `SUSPEND INTEGRATION` audit entry (old and new status) in one transaction.
- Audit: `SUSPEND INTEGRATION` (table `integrated_apps`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: repeating returns 409 `INVALID_LIFECYCLE_TRANSITION`.

### POST `/integrations/:integration_id/disconnect` — Disconnect integration

#### Purpose
Permanently disconnects the integration: destroys its credential and disables all subscriptions. Terminal and irreversible. Events already accepted are still processed.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)

#### Prerequisites
- `integrationId`.
- Integration must currently be `pending`, `active` or `suspended`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
No request body. A non-empty JSON body is rejected with 400 `INVALID_REQUEST`.

#### Expected responses
- **200 OK**: Transitioned to `revoked`.

  ```json
  {
    "message": "Integration disconnected.",
    "data": {
      "id": 9,
      "tenantId": 4,
      "name": "Acme storefront",
      "description": null,
      "appKey": "bean_Qx3-example",
      "status": "revoked",
      "appUrl": "https://store.example.com",
      "webhookUrl": null,
      "lastEventAt": null,
      "credentialConfigured": true,
      "credentialRotatedAt": "2026-10-20T09:00:00.000Z",
      "createdByUserId": 12,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID.

  ```json
  {
    "error": {
      "code": "INVALID_INTEGRATION_ID",
      "message": "A valid integration ID is required."
    }
  }
  ```
- **400 Bad Request**: Body supplied.

  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "This operation does not accept a request body."
    }
  }
  ```
- **403 Forbidden**: Caller is a plain member of the owning tenant.

  ```json
  {
    "error": {
      "code": "TENANT_ADMIN_REQUIRED",
      "message": "Tenant administrator access is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```
- **409 Conflict**: Current status does not allow this transition.

  ```json
  {
    "error": {
      "code": "INVALID_LIFECYCLE_TRANSITION",
      "message": "An integration in status revoked cannot be disconnected."
    }
  }
  ```

#### Side effects
- Sets `integrated_apps.status` to `revoked`.
- Nulls the credential hash and disables every subscription.
- Writes lifecycle activity and an `DISCONNECT INTEGRATION` audit entry (old and new status) in one transaction.
- Audit: `DISCONNECT INTEGRATION` (table `integrated_apps`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: repeating returns 409 `INVALID_LIFECYCLE_TRANSITION`.

### POST `/integrations/:integration_id/credentials/rotate` — Rotate credential

#### Purpose
Issues a new one-time bearer secret and invalidates the previous one immediately.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)
- Rate limited to 10 rotations per hour per IP (the limiter runs before authentication).

#### Prerequisites
- `integrationId` and `tenantId`; integration not revoked.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `tenantId` | integer | yes | Must be the tenant that owns the integration. No other keys. |

Valid example:
```json
{
  "tenantId": {{tenantId}}
}
```

Invalid example (400: A valid tenantId is required.):
```json
{}
```

#### Expected responses
- **200 OK**: Rotated; secret shown once.

  ```json
  {
    "message": "Integration credential rotated. Store this secret now; it will not be shown again.",
    "data": {
      "integrationId": 9,
      "appKey": "bean_Qx3-example",
      "credential": "<one-time secret>"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "message": "A valid tenantId is required; no other fields are accepted."
  }
  ```
- **403 Forbidden**: Plain member.

  ```json
  {
    "message": "Tenant administrator access is required."
  }
  ```
- **404 Not Found**: Wrong tenant/ID or not a member.

  ```json
  {
    "message": "Integration not found for this tenant."
  }
  ```
- **409 Conflict**: Disconnected.

  ```json
  {
    "message": "A revoked integration cannot rotate credentials."
  }
  ```
- **429 Too Many Requests**: Hourly limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many credential rotation requests."
    }
  }
  ```

#### Side effects
- Replaces `credential_hash`.
- Writes lifecycle activity `credential.rotated` and a `ROTATE INTEGRATION CREDENTIAL` audit entry (no secret).
- Audit: `ROTATE INTEGRATION CREDENTIAL` (tenant-scoped, transactional); failures are recorded in lifecycle activity.

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Each call invalidates the previous secret; update `integrationCredential` afterwards.

### GET `/integrations/tenants/:tenant_id/settings` — Get integration settings

#### Purpose
Returns the tenant-wide integration settings (currently the inventory shortage policy).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: owner or admin
- Non-members and plain members both get 403.

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Defaults to `require_intervention` when never set.

  ```json
  {
    "message": "Integration settings retrieved successfully.",
    "data": {
      "tenantId": 4,
      "inventoryShortagePolicy": "require_intervention",
      "updatedAt": null
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID.

  ```json
  {
    "message": "A valid tenant ID is required."
  }
  ```
- **403 Forbidden**: Not an owner/admin of the tenant.

  ```json
  {
    "message": "Tenant administrator access is required."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### PUT `/integrations/tenants/:tenant_id/settings/inventory-policy` — Set inventory shortage policy

#### Purpose
Chooses how sale events behave when stock is insufficient.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of the tenant that owns the integration (re-checked inside the transaction)

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenant_id` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `inventoryShortagePolicy` | string | yes | `require_intervention`, `allow_negative_inventory` or `record_sale_without_stock_deduction`. Exactly one key. |

Valid example:
```json
{
  "inventoryShortagePolicy": "require_intervention"
}
```

Invalid example (400: Provide exactly one supported value.):
```json
{
  "inventoryShortagePolicy": "yolo"
}
```

#### Expected responses
- **200 OK**: Saved (upsert).

  ```json
  {
    "message": "Inventory shortage policy updated successfully.",
    "data": {
      "tenantId": 4,
      "inventoryShortagePolicy": "require_intervention",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "message": "Provide exactly one supported inventoryShortagePolicy value."
  }
  ```
- **403 Forbidden**: Not an owner/admin.

  ```json
  {
    "message": "Tenant administrator access is required."
  }
  ```

#### Side effects
- Upserts `tenant_integration_settings`.
- Writes lifecycle activity for each of the tenant's integrations and an `UPDATE INTEGRATION INVENTORY POLICY` audit entry.
- Audit: `UPDATE INTEGRATION INVENTORY POLICY` (tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (upsert; each call adds audit rows).

### POST `/integrations/:integration_id/events` — Deliver integration event (app → Bean)

#### Purpose
Server-to-server endpoint an integrated app calls to deliver a business event. The event is validated, deduplicated by `eventId`, queued, and processed later by the background worker.

#### Authentication and permissions
- Session: not required
- Account permission: none
- Tenant membership/role: not applicable
- No session and no origin check. Authenticated by app key + bearer secret (bcrypt-verified; timing is equalised for unknown/inactive apps). Rate limited to 120 requests per minute per IP.

#### Prerequisites
- The integration must be `active` with the event type subscribed. Set `integrationAppKey` and `integrationCredential` (from **Register integration** / **Rotate credential**).

#### Headers
- `Cookie: bean.sid=...`: not used.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `X-Bean-App-Key: {{integrationAppKey}}`: Required. 8-100 characters; must equal the integration's `appKey`.
- `Authorization: Bearer {{integrationCredential}}`: Required. `Bearer ` + the 32-256 character secret.
- CSRF: not applicable (server-to-server, no cookies).

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `eventId` | string | yes | 1-255 characters of `A-Za-z0-9._:-`; the deduplication key per integration. |
| `eventType` | string | yes | Registered, active and subscribed (`transaction.completed` or `inventory.adjusted`). |
| `occurredAt` | string (ISO-8601 with zone) | yes | Not more than 5 minutes in the future. |
| `payload` | object | yes | `transaction.completed`: `externalTransactionId`, `productId`, `quantity` (int ≥ 1), `status` = `completed`, `saleAmount`, `currency` (3 upper-case letters), `externalUserId`. `inventory.adjusted`: `productId`, `quantity` (int ≥ 1), `adjustment` = `increase`/`decrease`/`set`. No extra fields. |
| `correlationId` | string | no | Same character set as `eventId`; defaults to the request ID. |

Valid example:
```json
{
  "eventId": "{{externalEventId}}",
  "eventType": "inventory.adjusted",
  "occurredAt": "{{eventOccurredAt}}",
  "payload": {
    "productId": "BEAN-42",
    "quantity": 5,
    "adjustment": "increase"
  }
}
```

Invalid example (400: `INVALID_EVENT`.):
```json
{
  "eventId": "bad id",
  "eventType": "x"
}
```

#### Expected responses
- **202 Accepted**: Accepted and queued.

  ```json
  {
    "message": "Integration event accepted for processing.",
    "data": {
      "integrationId": 9,
      "eventId": "qa-1",
      "status": "pending",
      "receivedAt": "2026-10-20T09:00:01.000Z"
    }
  }
  ```
- **200 OK**: Same `eventId` already received.

  ```json
  {
    "message": "Integration event was already received.",
    "data": {
      "integrationId": 9,
      "eventId": "qa-1",
      "status": "duplicate"
    }
  }
  ```
- **400 Bad Request**: Also `INVALID_EVENT_PAYLOAD`, and malformed JSON (`BAD_REQUEST`).

  ```json
  {
    "error": {
      "code": "INVALID_EVENT",
      "message": "Event envelope is invalid."
    }
  }
  ```
- **401 Unauthorized**: Bad key/secret, wrong or inactive integration, suspended, or inactive tenant.

  ```json
  {
    "error": {
      "code": "INTEGRATION_AUTH_FAILED",
      "message": "Integration credentials are invalid."
    }
  }
  ```
- **413 Payload Too Large**: Body over 100 KB.

  ```json
  {
    "error": {
      "code": "PAYLOAD_TOO_LARGE",
      "message": "Request payload is too large."
    }
  }
  ```
- **422 Unprocessable Entity**: Also `UNSUPPORTED_HANDLER`, `EVENT_POLICY_CHANGED`.

  ```json
  {
    "error": {
      "code": "EVENT_NOT_SUBSCRIBED",
      "message": "Event type is not registered and enabled for this integration."
    }
  }
  ```
- **429 Too Many Requests**: Rate limit.

  ```json
  {
    "error": {
      "code": "RATE_LIMITED",
      "message": "Too many integration events. Try again shortly."
    }
  }
  ```

#### Side effects
- Inserts deduplication, `integration_events` and diagnostics rows and updates `last_event_at`, in one transaction.
- The worker later applies the business effect (sale, stock adjustment, commission) per event.
- Audit: No `audit_logs` row: ingestion is recorded in `integration_event_diagnostics` (visible via the diagnostics and activity endpoints). The business effect is audited by the worker.

#### Testing notes
- Asserts status 202 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: re-sending an `eventId` returns 200 `duplicate`; the pre-request script generates a fresh `eventId` each run.

### GET `/integrations/events` — Search integration events

#### Purpose
Searches queued/processed events of a tenant with filters.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of `tenantId`
- Non-members get 403.

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | query | positive integer | Required. Tenant whose data to search; caller must be a member. | `{{tenantId}}` |
| `eventId` | query | string | Exact external event ID. | `storefront-event-9081` |
| `correlationId` | query | string | Exact correlation ID (max 255). | `corr-1` |
| `externalTransactionId` | query | string | Exact external transaction ID (max 255). | `ORDER-1` |
| `internalEventId` | query | positive integer | Internal event row ID. | `77` |
| `integrationId` | query | positive integer | Limit to one integration. | `{{integrationId}}` |
| `eventType` | query | string | e.g. `transaction.completed`. | `transaction.completed` |
| `status` | query | enum | `pending`, `processing`, `processed` or `failed`. | `failed` |
| `errorCode` | query | string | Exact error code (max 100). | `INSUFFICIENT_STOCK` |
| `from` | query | ISO-8601 timestamp | Inclusive lower bound. | `2026-10-01T00:00:00Z` |
| `to` | query | ISO-8601 timestamp | Inclusive upper bound; must not be earlier than `from`. | `2026-10-28T00:00:00Z` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Matching events.

  ```json
  {
    "message": "Integration events retrieved successfully.",
    "data": [
      {
        "id": 77,
        "tenantId": 4,
        "integrationId": 9,
        "eventId": "storefront-event-9081",
        "eventType": "transaction.completed",
        "handlerKey": "sale",
        "correlationId": "corr-1",
        "occurredAt": "2026-10-20T09:00:00.000Z",
        "receivedAt": "2026-10-20T09:00:01.000Z",
        "status": "failed",
        "attemptCount": 5,
        "processedAt": null,
        "lastAttemptAt": "2026-10-20T09:10:00.000Z",
        "lastFailedAt": "2026-10-20T09:10:00.000Z",
        "nextAttemptAt": null,
        "errorCode": "INSUFFICIENT_STOCK",
        "errorSummary": "Insufficient stock for product BEAN-42.",
        "failureClassification": "action_required"
      }
    ],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **403 Forbidden**: Caller is not a member of `tenantId`.

  ```json
  {
    "message": "Forbidden."
  }
  ```
- **400 Bad Request**: Missing tenantId or an invalid filter (`status is invalid.`, `from must be a valid timestamp.`, ...).

  ```json
  {
    "message": "A valid tenantId is required."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/integrations/events/:event_id` — Get event timeline

#### Purpose
Returns one event with every processing attempt and delivery diagnostic.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of `tenantId`

#### Prerequisites
- `tenantId`; an internal event ID (run **Search integration events**).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `event_id` | path | positive integer | Internal event ID (the `id` field from search results, not the external `eventId`). | `{{internalEventId}}` |
| `tenantId` | query | positive integer | Required. Tenant whose data to search; caller must be a member. | `{{tenantId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Timeline.

  ```json
  {
    "message": "Integration event timeline retrieved successfully.",
    "data": {
      "event": {
        "id": 77,
        "tenantId": 4,
        "integrationId": 9,
        "eventId": "storefront-event-9081",
        "eventType": "transaction.completed",
        "handlerKey": "sale",
        "correlationId": "corr-1",
        "occurredAt": "2026-10-20T09:00:00.000Z",
        "receivedAt": "2026-10-20T09:00:01.000Z",
        "status": "failed",
        "attemptCount": 5,
        "processedAt": null,
        "lastAttemptAt": "2026-10-20T09:10:00.000Z",
        "lastFailedAt": "2026-10-20T09:10:00.000Z",
        "nextAttemptAt": null,
        "errorCode": "INSUFFICIENT_STOCK",
        "errorSummary": "Insufficient stock for product BEAN-42.",
        "failureClassification": "action_required"
      },
      "handlerKey": "sale",
      "attempts": [],
      "diagnostics": []
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **403 Forbidden**: Caller is not a member of `tenantId`.

  ```json
  {
    "message": "Forbidden."
  }
  ```
- **400 Bad Request**: Malformed IDs.

  ```json
  {
    "message": "A valid event ID and tenantId are required."
  }
  ```
- **404 Not Found**: Not in this tenant.

  ```json
  {
    "message": "Integration event not found."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/integrations/events/:event_id/retry` — Retry failed event

#### Purpose
Re-queues an event that failed with an `action_required` classification after someone fixed the cause (for example, restocked inventory).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_MANAGE`
- Tenant membership/role: owner or admin of `tenantId`

#### Prerequisites
- A failed, action-required event (see **Search integration events** with `status=failed`).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `event_id` | path | positive integer | Internal event ID. | `{{internalEventId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `tenantId` | integer | yes | Positive JSON integer. |
| `reason` | string | yes | 10-500 characters after trimming. |

Valid example:
```json
{
  "tenantId": {{tenantId}},
  "reason": "Inventory restocked after shortage."
}
```

Invalid example (400: Reason too short.):
```json
{
  "tenantId": 4,
  "reason": "short"
}
```

#### Expected responses
- **202 Accepted**: Queued for manual retry.

  ```json
  {
    "message": "Integration event queued for manual retry.",
    "data": {
      "id": 77,
      "eventId": "storefront-event-9081",
      "status": "pending"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "message": "A valid tenantId and a 10 to 500 character retry reason are required."
  }
  ```
- **403 Forbidden**: Not an owner/admin.

  ```json
  {
    "message": "Tenant administrator access is required."
  }
  ```
- **409 Conflict**: Not failed + action_required.

  ```json
  {
    "message": "This event is not eligible for manual retry."
  }
  ```

#### Side effects
- Resets the event to `pending`, records who requested the retry and why.
- Writes a `RETRY INTEGRATION EVENT` audit entry in the same transaction.
- Audit: `RETRY INTEGRATION EVENT` (tenant-scoped, transactional).

#### Testing notes
- Asserts status 202 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a pending event is no longer eligible (409).
- Requires a failed event; against a fresh database this request returns 409 and that is the expected, asserted outcome of the sample test.

### GET `/integrations/diagnostics` — Search delivery diagnostics

#### Purpose
Searches delivery diagnostics (accepted, duplicate, invalid, failed-ingestion deliveries) for a tenant.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of `tenantId`

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | query | positive integer | Required. Tenant whose data to search; caller must be a member. | `{{tenantId}}` |
| `integrationId` | query | positive integer | Limit to one integration. | `{{integrationId}}` |
| `requestId` | query | string | Exact request ID (`X-Request-Id` of the delivery). |  |
| `eventId` | query | string | Exact external event ID. |  |
| `outcome` | query | string | Exact outcome, e.g. `accepted`, `duplicate`, `invalid`. | `invalid` |
| `errorCode` | query | string | Exact error code. |  |
| `from` | query | ISO-8601 timestamp | Inclusive lower bound. | `2026-10-01T00:00:00Z` |
| `to` | query | ISO-8601 timestamp | Inclusive upper bound; must not be earlier than `from`. | `2026-10-28T00:00:00Z` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Diagnostics.

  ```json
  {
    "message": "Integration diagnostics retrieved successfully.",
    "data": [
      {
        "id": 5,
        "requestId": "3f0c2c1e",
        "eventId": "qa-1",
        "eventType": "inventory.adjusted",
        "correlationId": "corr-1",
        "integrationId": 9,
        "receivedAt": "2026-10-20T09:00:01.000Z",
        "outcome": "accepted",
        "errorCode": null,
        "errorSummary": null,
        "httpStatus": 202
      }
    ],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **403 Forbidden**: Caller is not a member of `tenantId`.

  ```json
  {
    "message": "Forbidden."
  }
  ```
- **400 Bad Request**: Missing tenantId or invalid filter.

  ```json
  {
    "message": "A valid tenantId is required."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/integrations/diagnostics/unauthorized` — Unauthorized delivery attempts (platform)

#### Purpose
Lists deliveries that could not be attributed to any integration (bad credentials). Platform operators only.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `PLATFORM_AUDIT_READ`
- Tenant membership/role: not applicable
- Not tenant-scoped.

#### Prerequisites
- An operator account with `PLATFORM_AUDIT_READ`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Attempts (paginated; default limit 20).

  ```json
  {
    "message": "Unauthorized integration attempts retrieved successfully.",
    "data": [
      {
        "id": 8,
        "requestId": "3f0c2c1e",
        "receivedAt": "2026-10-20T09:00:01.000Z",
        "errorCode": "INTEGRATION_AUTH_FAILED",
        "httpStatus": 401
      }
    ],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Invalid pagination parameters.

  ```json
  {
    "message": "The limit must be an integer between 1 and 20."
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/integrations/:integration_id/activity` — Integration activity feed

#### Purpose
Unified, newest-first feed for one integration: queued events, delivery diagnostics, processing attempts, sales and analytics deliveries.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of the tenant

#### Prerequisites
- `integrationId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |
| `tenantId` | query | positive integer | Optional. When sent it must match the integration's tenant (otherwise 404). | `{{tenantId}}` |
| `eventType` | query | string | e.g. `transaction.completed`. | `transaction.completed` |
| `status` | query | enum | `pending`, `processing`, `processed`, `failed`, `accepted`, `duplicate`, `invalid`, `ingestion_failed`, `started`, `retry_scheduled`, `lease_expired`, `completed`. | `processed` |
| `recordType` | query | enum | `integration_event`, `delivery_diagnostic`, `processing_attempt`, `sale`, `analytics_outbox`. | `integration_event` |
| `from` | query | ISO-8601 timestamp | Inclusive lower bound. | `2026-10-01T00:00:00Z` |
| `to` | query | ISO-8601 timestamp | Inclusive upper bound; must not be earlier than `from`. | `2026-10-28T00:00:00Z` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Feed rows.

  ```json
  {
    "message": "Integration activity retrieved successfully.",
    "data": [
      {
        "id": 77,
        "recordType": "integration_event",
        "eventId": "qa-1",
        "internalEventId": 77,
        "eventType": "inventory.adjusted",
        "externalTransactionId": null,
        "correlationId": "corr-1",
        "occurredAt": "2026-10-20T09:00:01.000Z",
        "stage": "queue",
        "status": "processed",
        "errorCode": null,
        "errorSummary": null,
        "relatedRecordId": null,
        "receivedAt": "2026-10-20T09:00:01.000Z",
        "eventOccurredAt": "2026-10-20T09:00:00.000Z",
        "processedAt": "2026-10-20T09:05:00.000Z",
        "attemptCount": 1
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID; filter errors use `{ "message": "status is invalid." }`.

  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "A valid integration ID (and tenantId, if given) is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/integrations/:integration_id/audit` — Integration audit history

#### Purpose
Merged audit-log and lifecycle history for one integration; sensitive fields are stripped from before/after snapshots.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of the tenant

#### Prerequisites
- `integrationId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |
| `tenantId` | query | positive integer | Optional. When sent it must match the integration's tenant (otherwise 404). | `{{tenantId}}` |
| `source` | query | enum | `audit_log` or `lifecycle`. | `lifecycle` |
| `actor` | query | enum | `user` or `system`. | `user` |
| `from` | query | ISO-8601 timestamp | Inclusive lower bound. | `2026-10-01T00:00:00Z` |
| `to` | query | ISO-8601 timestamp | Inclusive upper bound; must not be earlier than `from`. | `2026-10-28T00:00:00Z` |
| `page` | query | integer | 1-based page number. Mutually exclusive with `offset`. | `1` |
| `limit` | query | integer | Page size, 1 to 20 (default 20 once any paging parameter is sent). | `20` |
| `offset` | query | integer | Zero-based row offset. Mutually exclusive with `page`. | `0` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: History rows.

  ```json
  {
    "message": "Integration audit history retrieved successfully.",
    "data": [
      {
        "id": "lifecycle-3",
        "source": "lifecycle",
        "occurredAt": "2026-10-20T09:00:00.000Z",
        "action": "integration.created",
        "actorUserId": 12,
        "actorType": "user",
        "resourceType": "integrated_app",
        "resourceId": "9",
        "outcome": "succeeded",
        "errorCode": null,
        "errorSummary": null,
        "correlationId": "3f0c2c1e",
        "changes": null
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "offset": 0,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Malformed ID; filter errors use `{ "message": "source must be audit_log or lifecycle." }`.

  ```json
  {
    "error": {
      "code": "INVALID_REQUEST",
      "message": "A valid integration ID (and tenantId, if given) is required."
    }
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/integrations/:integration_id/analytics` — Integration analytics

#### Purpose
Aggregated delivery, processing, sales, commission and inventory-adjustment statistics for one integration over a time window (default last 30 days, max 366 days).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: `INTEGRATIONS_READ`
- Tenant membership/role: any member of the tenant

#### Prerequisites
- `integrationId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `integration_id` | path | positive integer | Integrated app ID. The tenant is derived from the integration row, never supplied by the client. | `{{integrationId}}` |
| `tenantId` | query | positive integer | Optional. When sent it must match the integration's tenant (otherwise 404). | `{{tenantId}}` |
| `from` | query | ISO-8601 timestamp | Inclusive lower bound. | `2026-10-01T00:00:00Z` |
| `to` | query | ISO-8601 timestamp | Inclusive upper bound; must not be earlier than `from`. | `2026-10-28T00:00:00Z` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Read-only snapshot (repeatable-read transaction). Only `from`, `to` and `tenantId` query parameters are accepted.

  ```json
  {
    "message": "Integration analytics retrieved successfully.",
    "data": {
      "schemaVersion": 1,
      "integrationId": 9,
      "window": {
        "from": "2026-09-28T00:00:00.000Z",
        "to": "2026-10-28T00:00:00.000Z"
      },
      "events": {
        "total": 0,
        "byStatus": {
          "pending": 0,
          "processing": 0,
          "processed": 0,
          "failed": 0
        },
        "byType": [],
        "successRate": null,
        "topFailureCodes": []
      },
      "deliveries": "{...}",
      "processingLatencyMs": {
        "samples": 0,
        "average": null,
        "p50": null,
        "p95": null,
        "max": null
      },
      "sales": {
        "available": true,
        "byCurrency": []
      },
      "commissions": {
        "available": true,
        "byCurrency": []
      },
      "inventoryAdjustments": {
        "available": true,
        "total": 0,
        "byAdjustment": {}
      },
      "limitations": [
        "..."
      ]
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **403 Forbidden**: The account role lacks a required permission.

  ```json
  {
    "message": "Forbidden: You do not have the required permissions.",
    "error": {
      "code": "PERMISSION_REQUIRED",
      "message": "Forbidden: You do not have the required permissions."
    }
  }
  ```
- **400 Bad Request**: Unknown parameter or bad window (`The time window may not exceed 366 days.`).

  ```json
  {
    "message": "Only from, to, and tenantId query parameters are supported."
  }
  ```
- **404 Not Found**: Not a member of the tenant that owns it, wrong tenant, or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "INTEGRATION_NOT_FOUND",
      "message": "Integration not found."
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

## Tickets

### GET `/ticketing/tenants/:tenantId/inboxes` — List inboxes

#### Purpose
Lists the tenant's helpdesk inboxes (name, address, description). Managers see inactive inboxes too.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: any member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Array (possibly empty).

  ```json
  {
    "data": [
      {
        "id": "1",
        "tenantId": "4",
        "name": "Support",
        "email": "support@acme.test",
        "description": null,
        "isActive": true,
        "createdByUserId": "12",
        "createdAt": "2026-10-20T09:00:00.000Z",
        "updatedAt": "2026-10-20T09:00:00.000Z"
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/ticketing/tenants/:tenantId/inboxes` — Create inbox

#### Purpose
Registers a helpdesk inbox address that tickets can be associated with. Email ingestion/delivery is not implemented.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1-150 characters. |
| `email` | string | yes | Valid email, max 320 characters; lower-cased; unique per tenant. |
| `description` | string | no | Max 2000 characters. |

Valid example:
```json
{
  "name": "Support",
  "email": "{{inboxEmail}}",
  "description": "Customer support inbox"
}
```

Invalid example (400: A valid inbox email is required.):
```json
{
  "name": "Support",
  "email": "nope"
}
```

#### Expected responses
- **201 Created**: Created.

  ```json
  {
    "data": {
      "id": "1",
      "tenantId": "4",
      "name": "Support",
      "email": "support@acme.test",
      "description": null,
      "isActive": true,
      "createdByUserId": "12",
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Plain members cannot perform this action.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Tenant owner or admin access is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid inbox email is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Duplicate address in the tenant.

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "An inbox with this email already exists.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Inserts a `ticket_inboxes` row.
- Writes a `TICKET_INBOX_CREATE` audit entry in the same transaction.
- Audit: `TICKET_INBOX_CREATE` (table `ticket_inboxes`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No with a fixed address (409); the pre-request script generates a unique one.

### GET `/ticketing/tenants/:tenantId/tickets` — List tickets

#### Purpose
Lists tickets newest first. Managers see every ticket in the tenant; other members only tickets they requested, created, or are/were actively assigned to.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: any member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `tenantId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `page` | query | integer | 1-based page (default 1). | `1` |
| `limit` | query | integer | 1 to 20 (default 20). | `20` |
| `status` | query | enum | `open`, `acknowledged`, `in_progress`, `pending`, `resolved`, `closed`, `cancelled`. | `open` |
| `ticketType` | query | enum | `support`, `task`, `hr_task`, `bug`, `incident`. | `support` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Flat `{ data, pagination }`, like every other list endpoint.

  ```json
  {
    "data": [
      {
        "id": "7",
        "tenantId": "4",
        "ticketNumber": "13",
        "title": "Printer broken",
        "description": "The label printer jams.",
        "ticketType": "support",
        "status": "open",
        "priority": "medium",
        "requesterUserId": "12",
        "inboxId": null,
        "assignedToUserId": null,
        "createdByUserId": "12",
        "parentTicketId": null,
        "dueAt": null,
        "acknowledgedAt": null,
        "resolvedAt": null,
        "closedAt": null,
        "createdAt": "2026-10-20T09:00:00.000Z",
        "updatedAt": "2026-10-20T09:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1,
      "totalPages": 1,
      "hasMore": false
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Bad `page`/`limit`; invalid `status` / `ticket type` filters also return 400.

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Invalid pagination.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/ticketing/tenants/:tenantId/tickets` — Create ticket

#### Purpose
Opens a ticket (status `open`). Plain members can only raise tickets for themselves; managers may set another tenant member as requester.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: any member (managers only for `requesterUserId` ≠ self)
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `tenantId`; optional `inboxId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | yes | 1-250 characters after trimming. |
| `description` | string | no | Max 10000 characters. |
| `ticketType` | string | no | `support` (default), `task`, `hr_task`, `bug`, `incident`. |
| `priority` | string | no | `low`, `medium` (default), `high`, `urgent`. |
| `inboxId` | ID | no | Active inbox in this tenant. |
| `parentTicketId` | ID | no | A ticket the caller can read in this tenant. |
| `requesterUserId` | ID | no | Active tenant member; default is the caller; others need manager role. |
| `dueAt` | string (ISO-8601) | no | Parseable date-time; stored as UTC. |

Valid example:
```json
{
  "title": "Printer broken",
  "description": "The label printer jams.",
  "ticketType": "support",
  "priority": "medium"
}
```

Invalid example (400: Title must be 1 to 250 characters.):
```json
{
  "description": "no title"
}
```

#### Expected responses
- **201 Created**: Created with a per-tenant `ticketNumber`.

  ```json
  {
    "data": {
      "id": "7",
      "tenantId": "4",
      "ticketNumber": "13",
      "title": "Printer broken",
      "description": "The label printer jams.",
      "ticketType": "support",
      "status": "open",
      "priority": "medium",
      "requesterUserId": "12",
      "inboxId": null,
      "assignedToUserId": null,
      "createdByUserId": "12",
      "parentTicketId": null,
      "dueAt": null,
      "acknowledgedAt": null,
      "resolvedAt": null,
      "closedAt": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Validation failure (also `Invalid ticket type.`, `Invalid priority.`, `Invalid due date.`, `Inbox not found for this tenant.`, `The selected user is not an active tenant member.`).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Title must be 1 to 250 characters.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Member set another requester.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "You can only create tickets for yourself.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Unreadable or missing `parentTicketId`.

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Inserts a `tickets` row and a `created` `ticket_activity` row.
- Writes a `TICKET_CREATE` audit entry; all three commit or roll back together.
- Audit: `TICKET_CREATE` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: every call opens another ticket (no duplicate-submission guard).

### GET `/ticketing/tenants/:tenantId/tickets/:ticketId` — Get ticket

#### Purpose
Returns one ticket the caller may read (manager, requester, creator, assignee or past/current assignee).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId` (run **Create ticket**).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Found.

  ```json
  {
    "data": {
      "id": "7",
      "tenantId": "4",
      "ticketNumber": "13",
      "title": "Printer broken",
      "description": "The label printer jams.",
      "ticketType": "support",
      "status": "open",
      "priority": "medium",
      "requesterUserId": "12",
      "inboxId": null,
      "assignedToUserId": null,
      "createdByUserId": "12",
      "parentTicketId": null,
      "dueAt": null,
      "acknowledgedAt": null,
      "resolvedAt": null,
      "closedAt": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/ticketing/tenants/:tenantId/tickets/:ticketId/assignments` — List assignments

#### Purpose
Assignment history of a ticket, newest first (current assignment has `unassignedAt: null`). Notes are only shown to managers.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Array.

  ```json
  {
    "data": [
      {
        "id": "2",
        "userId": "15",
        "assignedByUserId": "12",
        "isPrimary": true,
        "assignedAt": "2026-10-20T09:05:00.000Z",
        "unassignedAt": null,
        "notes": "Please take this."
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/ticketing/tenants/:tenantId/tickets/:ticketId/assignments` — Assign ticket

#### Purpose
Assigns (or reassigns) the ticket to an active tenant member. The previous primary assignment is closed. Assigning the current assignee again is a no-op.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`; `memberUserId` set to an active tenant member (run **Add member** or **List members**).

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `userId` | ID | yes | Active tenant member. |
| `notes` | string | no | Max 2000 characters. |

Valid example:
```json
{
  "userId": "{{memberUserId}}",
  "notes": "Please take this."
}
```

Invalid example (400: A valid assignee user ID is required.):
```json
{
  "notes": "x"
}
```

#### Expected responses
- **200 OK**: Returns the updated ticket.

  ```json
  {
    "data": {
      "id": "7",
      "tenantId": "4",
      "ticketNumber": "13",
      "title": "Printer broken",
      "description": "The label printer jams.",
      "ticketType": "support",
      "status": "open",
      "priority": "medium",
      "requesterUserId": "12",
      "inboxId": null,
      "assignedToUserId": "15",
      "createdByUserId": "12",
      "parentTicketId": null,
      "dueAt": null,
      "acknowledgedAt": null,
      "resolvedAt": null,
      "closedAt": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Plain members cannot perform this action.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Tenant owner or admin access is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Also `A valid assignee user ID is required.`

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "The selected user is not an active tenant member.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Ticket is resolved, closed or cancelled.

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "This ticket cannot be assigned.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Closes the open assignment row, inserts a new primary one and updates `assigned_to_user_id`.
- Writes an `assigned` activity row and a `TICKET_ASSIGN` audit entry (not written when the assignee is unchanged).
- Audit: `TICKET_ASSIGN` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes: re-assigning the same user changes nothing and writes no audit entry.
- Known gap: reassigning an already acknowledged ticket keeps status `acknowledged`, so the new assignee cannot acknowledge it (acknowledge requires `open`).

### POST `/ticketing/tenants/:tenantId/tickets/:ticketId/acknowledge` — Acknowledge ticket

#### Purpose
The assigned employee confirms they have picked up the ticket (`open` → `acknowledged`).

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: the assigned employee only (managers are not exempt)
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- Signed in as the current assignee of an `open` ticket.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body.

#### Expected responses
- **200 OK**: Acknowledged.

  ```json
  {
    "data": {
      "id": "7",
      "tenantId": "4",
      "ticketNumber": "13",
      "title": "Printer broken",
      "description": "The label printer jams.",
      "ticketType": "support",
      "status": "acknowledged",
      "priority": "medium",
      "requesterUserId": "12",
      "inboxId": null,
      "assignedToUserId": "15",
      "createdByUserId": "12",
      "parentTicketId": null,
      "dueAt": null,
      "acknowledgedAt": "2026-10-20T09:10:00.000Z",
      "resolvedAt": null,
      "closedAt": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Caller is not the assignee.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Only the assigned employee can acknowledge this ticket.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Not `open`, or already acknowledged.

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "Ticket cannot be acknowledged now.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Sets status `acknowledged` and `acknowledged_at`.
- Writes an `acknowledged` activity row and a `TICKET_ACKNOWLEDGE` audit entry.
- Audit: `TICKET_ACKNOWLEDGE` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 or 403 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a second call returns 409.
- Expected statuses 200 (as assignee) or 403/409 otherwise; the sample test accepts those outcomes because the collection user is usually the manager.

### PATCH `/ticketing/tenants/:tenantId/tickets/:ticketId/status` — Change ticket status

#### Purpose
Moves the ticket along its workflow. Allowed transitions: open → acknowledged | in_progress | cancelled; acknowledged → in_progress | pending | resolved | cancelled; in_progress → pending | resolved | cancelled; pending → in_progress | resolved | cancelled; resolved → in_progress | closed; closed and cancelled are terminal.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager or the current assignee; `closed` and `cancelled` need a manager
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `status` | string | yes | One of the seven statuses and a legal transition from the current one. |

Valid example:
```json
{
  "status": "in_progress"
}
```

Invalid example (400: Invalid status.):
```json
{
  "status": "done"
}
```

#### Expected responses
- **200 OK**: Returns the updated ticket (`resolvedAt` / `closedAt` set accordingly).

  ```json
  {
    "data": {
      "id": "7",
      "tenantId": "4",
      "ticketNumber": "13",
      "title": "Printer broken",
      "description": "The label printer jams.",
      "ticketType": "support",
      "status": "in_progress",
      "priority": "medium",
      "requesterUserId": "12",
      "inboxId": null,
      "assignedToUserId": null,
      "createdByUserId": "12",
      "parentTicketId": null,
      "dueAt": null,
      "acknowledgedAt": null,
      "resolvedAt": null,
      "closedAt": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Unknown status value or non-object body.

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Invalid status.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Also `Tenant owner or admin access is required.` for close/cancel.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Only managers or the assigned employee can change status.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Also `Revoke verified work before reopening this ticket.`

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "Invalid ticket status transition.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Updates status and timestamps under a row lock.
- Writes a `status_changed` activity row and a `TICKET_STATUS` audit entry.
- Audit: `TICKET_STATUS` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: repeating the same status is an invalid transition (409).

### GET `/ticketing/tenants/:tenantId/tickets/:ticketId/comments` — List comments

#### Purpose
Comments in chronological order. Internal notes are shown only to managers and the current assignee.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Array.

  ```json
  {
    "data": [
      {
        "id": "1",
        "authorUserId": "12",
        "body": "On it.",
        "isInternal": false,
        "createdAt": "2026-10-20T09:00:00.000Z",
        "updatedAt": "2026-10-20T09:00:00.000Z"
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/ticketing/tenants/:tenantId/tickets/:ticketId/comments` — Add comment

#### Purpose
Adds a public comment, or an internal note when `isInternal` is true.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member (internal notes: manager or assignee only)
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `body` | string | yes | 1-10000 characters after trimming. |
| `isInternal` | boolean | no | Default false. |

Valid example:
```json
{
  "body": "Looking into it.",
  "isInternal": false
}
```

Invalid example (400: Comment must be 1 to 10000 characters.):
```json
{
  "body": ""
}
```

#### Expected responses
- **201 Created**: Created.

  ```json
  {
    "data": {
      "id": "1",
      "authorUserId": "12",
      "body": "Looking into it.",
      "isInternal": false,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Also `isInternal must be a boolean.`

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Comment must be 1 to 10000 characters.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Requester tried an internal note.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Only managers or assignees can post internal comments.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Inserts a `ticket_comments` row and a `comment_added` activity row.
- Writes a `TICKET_COMMENT` audit entry.
- Audit: `TICKET_COMMENT` (table `tickets`, tenant-scoped, transactional; the comment text is not copied into the audit entry).

#### Testing notes
- Asserts status 201 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: each call adds a comment.

### GET `/ticketing/tenants/:tenantId/tickets/:ticketId/activity` — Ticket activity history

#### Purpose
Chronological activity (created, assigned, status changes, comments, estimates, verifications). Internal-comment events are hidden from non-managers who are not the assignee.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Array.

  ```json
  {
    "data": [
      {
        "id": "1",
        "actorUserId": "12",
        "activityType": "created",
        "fieldName": null,
        "oldValue": null,
        "newValue": {
          "ticketType": "support",
          "status": "open"
        },
        "metadata": {},
        "createdAt": "2026-10-20T09:00:00.000Z"
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### GET `/ticketing/tenants/:tenantId/tickets/:ticketId/story-points` — Get story-point estimate

#### Purpose
Returns the ticket's effort estimate, or `data: null` when none is set.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: `data` is `null` when no estimate exists.

  ```json
  {
    "data": {
      "id": "1",
      "ticketId": "7",
      "estimatedPoints": "5.00",
      "estimatedByUserId": "12",
      "estimateNotes": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### PUT `/ticketing/tenants/:tenantId/tickets/:ticketId/story-points` — Set story-point estimate

#### Purpose
Creates or replaces the ticket's effort estimate. Story points are effort, not pay or a performance rating.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `estimatedPoints` | number \| numeric string | yes | 0 to 9999.99, at most two decimals. |
| `estimateNotes` | string | no | Max 2000 characters. |

Valid example:
```json
{
  "estimatedPoints": 5,
  "estimateNotes": "Needs a part replaced."
}
```

Invalid example (400: Estimated points must be at most 9999.99 with two decimal places.):
```json
{
  "estimatedPoints": -1
}
```

#### Expected responses
- **200 OK**: Upserted.

  ```json
  {
    "data": {
      "id": "1",
      "ticketId": "7",
      "estimatedPoints": "5.00",
      "estimatedByUserId": "12",
      "estimateNotes": null,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Plain members cannot perform this action.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Tenant owner or admin access is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Estimated points must be at most 9999.99 with two decimal places.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Ticket closed/cancelled; also `Estimate cannot be below already verified points.`

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "This ticket cannot be estimated now.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Upserts `ticket_story_points` under a row lock.
- Writes an `estimate_changed` activity row and a `TICKET_ESTIMATE` audit entry.
- Audit: `TICKET_ESTIMATE` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: Yes (upsert; each call adds activity/audit rows).

### GET `/ticketing/tenants/:tenantId/tickets/:ticketId/verifications` — List work verifications

#### Purpose
Verified (and revoked) contribution records. Managers see all; others see only their own.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: manager, or involved member
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Array.

  ```json
  {
    "data": [
      {
        "id": "3",
        "ticketId": "7",
        "contributorUserId": "15",
        "verifiedPoints": "3.00",
        "verifiedByUserId": "12",
        "verificationStatus": "verified",
        "verificationNotes": null,
        "verifiedAt": "2026-10-20T09:00:00.000Z",
        "revokedAt": null,
        "revokedByUserId": null
      }
    ]
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

### POST `/ticketing/tenants/:tenantId/tickets/:ticketId/verifications` — Verify work

#### Purpose
A manager verifies a contributor's completed work, crediting points up to the ticket's estimate.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin (not the contributor)
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- A `resolved` or `closed` ticket with a positive estimate and the contributor having been assigned at some point.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Content-Type: application/json`: Required; Postman sets it automatically for a raw JSON body.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |

#### Request body
| Field | Type | Required | Constraints |
|---|---|---|---|
| `contributorUserId` | ID | yes | Active tenant member who was assigned to the ticket; not the caller. |
| `verifiedPoints` | number \| numeric string | yes | Greater than 0, at most 9999.99 (two decimals); total verified cannot exceed the estimate. |
| `verificationNotes` | string | no | Max 2000 characters. |

Valid example:
```json
{
  "contributorUserId": "{{memberUserId}}",
  "verifiedPoints": 3,
  "verificationNotes": "Printer fixed and tested."
}
```

Invalid example (403: Work cannot be self-verified.):
```json
{
  "contributorUserId": "{{currentUserId}}",
  "verifiedPoints": 3
}
```

#### Expected responses
- **201 Created**: Verified.

  ```json
  {
    "data": {
      "id": "3",
      "ticketId": "7",
      "contributorUserId": "15",
      "verifiedPoints": "3.00",
      "verifiedByUserId": "12",
      "verificationStatus": "verified",
      "verificationNotes": null,
      "verifiedAt": "2026-10-20T09:00:00.000Z",
      "revokedAt": null,
      "revokedByUserId": null
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Plain members cannot perform this action.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Tenant owner or admin access is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Validation failure.

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Verified points must be greater than zero and at most 9999.99 with two decimal places.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Contributor equals the caller.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Work cannot be self-verified.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Also: `Only assigned contributors can receive verified points.`, `This contribution is already verified.`, `A positive estimate is required before verification.`, `Verified points exceed the ticket estimate.`

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "Resolve the ticket before verifying work.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Inserts `ticket_work_verifications`, a `work_verified` activity row and a `TICKET_VERIFY` audit entry in one transaction.
- Audit: `TICKET_VERIFY` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 201 or 400 or 403 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a contribution can only be verified once until revoked (409).
- Needs a resolved ticket with an estimate and assignment; on a bare dataset the sample test accepts the documented 409/403 refusals.

### POST `/ticketing/tenants/:tenantId/tickets/:ticketId/verifications/:verificationId/revoke` — Revoke verification

#### Purpose
Revokes a previously verified contribution (for example, after a mistake), freeing the points again.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: owner or admin
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `ticketId` and a `verificationId` that is still `verified`.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- `Origin: {{origin}}`: Required on every non-GET request. Must equal one of the backend's `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.
- CSRF: there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `ticketId` | path | positive integer (bigint) | Ticket ID within the tenant. | `{{ticketId}}` |
| `verificationId` | path | positive integer (bigint) | Verification ID (from **List work verifications** or **Verify work**). | `{{verificationId}}` |

#### Request body
No request body.

#### Expected responses
- **200 OK**: Revoked.

  ```json
  {
    "data": {
      "id": "3",
      "ticketId": "7",
      "contributorUserId": "15",
      "verifiedPoints": "3.00",
      "verifiedByUserId": "12",
      "verificationStatus": "revoked",
      "verificationNotes": null,
      "verifiedAt": "2026-10-20T09:00:00.000Z",
      "revokedAt": "2026-10-21T09:00:00.000Z",
      "revokedByUserId": "12"
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Plain members cannot perform this action.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "Tenant owner or admin access is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Malformed ID (also `A valid tenant ID is required.`, etc.).

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "A valid ticket ID is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Ticket not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: Wrong ID or ticket.

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Verification not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: Already revoked.

  ```json
  {
    "error": {
      "code": "CONFLICT",
      "message": "Verification is already revoked.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- Marks the verification `revoked`.
- Writes a `verification_revoked` activity row and a `TICKET_VERIFY_REVOKE` audit entry.
- Audit: `TICKET_VERIFY_REVOKE` (table `tickets`, tenant-scoped, transactional).

#### Testing notes
- Asserts status 200 or 404 or 409 plus response-field checks.
- Changes persistent state: yes.
- Safe to repeat: No: a second call returns 409.

### GET `/ticketing/tenants/:tenantId/work-summary/:userId` — Employee work summary

#### Purpose
Counts of resolved tickets and verified points for one employee, optionally within a date range. A decision-support figure, not a performance rating.

#### Authentication and permissions
- Session: required (`bean.sid` cookie from **Log in**)
- Account permission: none
- Tenant membership/role: the employee themself, a manager, or a user whose account role has `TICKET_HR_READ`
- Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".

#### Prerequisites
- `tenantId` and a `userId`. `TICKET_HR_READ` is not seeded by any migration, so in practice only the employee or a manager can read a summary.

#### Headers
- `Cookie: bean.sid=...`: required; Postman's cookie jar sends it automatically after login.
- No additional headers.
- CSRF: safe method, no `Origin` check.

#### Path and query parameters
| Name | In | Type | Description | Example |
|---|---|---|---|---|
| `tenantId` | path | positive integer | Tenant ID. Only selects the tenant; authority comes from the caller's `tenant_members` role. | `{{tenantId}}` |
| `userId` | path | positive integer (bigint) | Employee (tenant member) to summarise. | `{{currentUserId}}` |
| `from` | query | date `YYYY-MM-DD` | Inclusive start (UTC). | `2026-10-01` |
| `to` | query | date `YYYY-MM-DD` | Inclusive end (UTC); not before `from`. | `2026-10-31` |

#### Request body
No request body is required.

#### Expected responses
- **200 OK**: Summary.

  ```json
  {
    "data": {
      "tenantId": "4",
      "userId": "15",
      "period": {
        "from": "2026-10-01",
        "to": "2026-10-31"
      },
      "resolvedTicketCount": 2,
      "verifiedTicketCount": 1,
      "verifiedPoints": "3.00",
      "note": "Story points are estimated effort, not a performance rating or compensation decision."
    }
  }
  ```
- **401 Unauthorized**: No valid session.

  ```json
  {
    "message": "Unauthorized. Please authenticate."
  }
  ```
- **404 Not Found**: Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).

  ```json
  {
    "error": {
      "code": "TENANT_NOT_FOUND",
      "message": "Tenant not found.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **409 Conflict**: The caller is a member but the tenant is not active.

  ```json
  {
    "error": {
      "code": "TENANT_INACTIVE",
      "message": "This tenant is not active.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **400 Bad Request**: Bad date or `From date must not be after to date.`

  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Invalid from date. Use YYYY-MM-DD.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **403 Forbidden**: Asking for someone else without being a manager.

  ```json
  {
    "error": {
      "code": "FORBIDDEN",
      "message": "HR work-summary permission is required.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```
- **404 Not Found**: User is not a member.

  ```json
  {
    "error": {
      "code": "NOT_FOUND",
      "message": "Employee not found in this tenant.",
      "requestId": "3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10"
    }
  }
  ```

#### Side effects
- None.
- Audit: None (read-only; access to HR-style summaries is not audited, see the QA report).

#### Testing notes
- Asserts status 200 plus response-field checks.
- Changes persistent state: no.
- Safe to repeat: Yes.

