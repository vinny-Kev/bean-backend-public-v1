# Frontend and Module Integration Guide

**Audience:** frontend developers and contributors adding backend modules.
**Last reviewed:** 2026-10-19

## 1. System Security Model

The backend uses an HTTP-only, cookie-backed session.

- The browser stores the `bean.sid` cookie.
- JavaScript must not read or copy that cookie.
- The server stores the session in PostgreSQL.
- The session stores the user ID and the authentication start time.
- Protected requests reload the current user from the database.
- Roles and permissions are not trusted from the browser or from stale session data.
- A deleted or disabled user must stop being accepted by the protected-request middleware.

The frontend should treat `401` as "authenticate again" and `403` as "authenticated but not allowed".

## 2. Browser Client Contract

Use cookie credentials on every request that needs the session:

```js
fetch('/inventory/all/', {
    credentials: 'include',
});
```

For JSON state-changing requests:

```js
fetch('/inventory/add/', {
    method: 'POST',
    credentials: 'include',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        name: 'Coffee',
        sku: 'COFFEE-001',
        quantity: 10,
        unit: 'unit',
    }),
});
```

The frontend must not:

- Read, persist, or manually set `bean.sid`.
- Put passwords, session IDs, or tokens in URLs.
- Assume that a successful login means the session lasts forever.
- Treat a client-side role or permission flag as authorization.
- Use a GET request for an operation that changes data.

## 3. CSRF and Origin Contract

Because browsers send cookies automatically, a malicious site could try to submit a state-changing request using the user's existing session. This is cross-site request forgery (CSRF).

The backend uses strict origin enforcement in `requireTrustedOrigin` and credentialed CORS for an explicit origin allowlist:

- `GET`, `HEAD`, and `OPTIONS` are treated as safe methods.
- State-changing methods must include an `Origin` header.
- The origin must exactly match one of the comma-separated entries in `APP_ORIGINS`.
- Requests with a missing or unapproved origin receive `403`.

Configure the exact frontend origin in the backend environment:

```env
APP_ORIGINS=http://localhost:5173
```

Production example:

```env
APP_ORIGINS=https://app.example.com
```

Do not use a wildcard origin with cookies. Multiple origins may be comma-separated, for example `APP_ORIGINS=https://app.example.com,https://admin.example.com`.

Non-browser clients must send the configured `Origin` header when using cookie authentication. A client that cannot do that should use a separately designed bearer-token contract instead of pretending to be a browser.

The origin check is defense in depth, not permission checking. Protected routes still need `sessionAuthMiddleware` and an explicit permission check.

## 4. Authentication Lifecycle

### Login

`POST /auth/login/`:

1. Validate the credentials.
2. Regenerate the session ID to prevent session fixation.
3. Store only the user ID and authentication start time in the session.
4. Return a safe user object only.

The login response may contain identity fields such as ID, username, email, and role. It must never contain `password`, `password_hash`, session IDs, or secrets.

### Protected requests

Every protected route must apply middleware in this order:

```js
router.post(
    '/add/',
    sessionAuthMiddleware,
    requirePermission('INVENTORY_ADD'),
    moduleValidation,
    moduleService
);
```

`sessionAuthMiddleware` must run before permission checks and module code. It checks the absolute session lifetime, reloads the current user, rejects disabled/deleted users, and attaches the current safe identity to `req.user`.

### Logout and expiry

`POST /auth/logout/` destroys the server-side session and clears the `bean.sid` cookie.

The session has two time limits:

- Idle timeout: one hour, refreshed by activity while `rolling` is enabled.
- Absolute lifetime: six hours from login, after which the user must authenticate again even if active.

The frontend should handle an expired-session `401` by clearing in-memory user state and sending the user to the login flow. Do not repeatedly retry the same request after a `401`.

## 5. Route and Response Conventions

Use HTTP methods by intent:

- `GET`: read-only operations.
- `POST`: create or trigger an operation.
- `PATCH`: partial update.
- `DELETE`: removal.

Every mutating endpoint must have:

- Explicit authentication middleware.
- Explicit permission middleware where authorization is required.
- Request validation with bounded strings, numbers, arrays, and objects.
- Parameterized SQL.
- A transaction when multiple writes must succeed together.
- A defined retry and idempotency policy.

Expected authentication responses:

- `401`: no valid session, expired session, missing current user, disabled/deleted user.
- `403`: valid identity but insufficient permission, or rejected request origin.
- `400`: malformed or invalid input.
- `409`: a valid request conflicts with existing state.
- `500`: unexpected server-side failure.

Use a stable response shape as the API grows. Do not expose database errors or stack traces to clients.

## 6. Adding a New Module

For each new module:

1. Add routes under a dedicated route file.
2. Keep request validation in middleware or schemas.
3. Keep business behavior in services.
4. Keep database queries in a repository or narrowly scoped data service.
5. Apply `sessionAuthMiddleware` to every protected route.
6. Add explicit permissions for every protected write.
7. Return allowlisted response fields rather than database rows.
8. Add tests for unauthenticated, unauthorized, invalid, successful, and conflicting requests.
9. Document the browser request and response contract.
10. Check that logs contain no passwords, cookies, session IDs, request bodies, or database credentials.

A module should never trust these values from the client:

- User ID or actor ID.
- Role or permission.
- Ownership or tenant ID.
- Audit actor.
- Record timestamps.

Derive those values from `req.user`, the database, or server-controlled request context.

## 7. Frontend Error Handling

Centralize API handling so authentication behavior is consistent:

```js
async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        credentials: 'include',
    });

    if (response.status === 401) {
        // Clear local user state and navigate to login.
    }

    if (response.status === 403) {
        // Show an access-denied state; do not retry automatically.
    }

    return response;
}
```

Do not display raw server errors to users. Use the server message only when it is known to be safe and map unexpected failures to a generic message.

## 8. Required Environment and Deployment Checks

Before using a frontend against the backend, verify:

- `SESSION_SECRET` is present and at least 32 characters long.
- `APP_ORIGINS` includes the browser origin exactly, including scheme and port.
- `HOST`, `PORT`, `NODE_ENV`, and PostgreSQL settings are configured for the deployment.
- `SESSION_SECRET` is unique to the environment, not the example value, and is at least 32 characters long.
- Production uses HTTPS and therefore `secure: true` cookies.
- The deployment's `sameSite` choice matches the frontend/backend relationship.
- CORS uses the explicit `APP_ORIGINS` allowlist.
- The proxy configuration preserves HTTPS information when TLS terminates upstream.
- Request body limits and security headers are enabled before public release.

## 9. Tests a New Module Must Add

At minimum, test:

- No session returns `401`.
- Expired session returns `401` and is destroyed.
- Disabled or deleted user returns `401`.
- Missing or untrusted origin returns `403` for state-changing requests.
- Authenticated user without permission returns `403`.
- Valid request succeeds.
- Invalid input does not write to the database.
- Duplicate or concurrent requests follow the module's conflict/idempotency policy.
- Responses and logs contain no sensitive fields.


## 10. Frontend Integration Checklist

Before opening a PR:

- [ ] API requests use `credentials: 'include'`
- [ ] Frontend does not access `bean.sid`
- [ ] `401` redirects to authentication flow
- [ ] `403` displays access denied
- [ ] No automatic retries on `401`
- [ ] No sensitive fields are stored in client state
- [ ] Mutating requests use the appropriate HTTP method
- [ ] Client-side permissions are treated as UI hints only
- [ ] Server authorization remains authoritative
