# Ticketing implementation log

## Files changed

- `services/ticketShared.js`: tenant membership checks, input validation, ticket access checks, database transactions, activity and audit helpers.
- `services/tickets.js`: ticket creation/list/detail, assignment history, acknowledgment, and status transitions.
- `services/conversation.js`: public/internal comments and filtered activity history.
- `services/inboxes.js`: tenant-scoped shared inbox records.
- `services/points.js`: estimates, verified contributions, revocation, and prevention of self-verification.
- `services/workSummary.js`: employee completion and verified-point summary with optional date range.
- `routes/ticket.routes.js`: authenticated HTTP endpoints and ticket-specific errors.
- `ticketing.test.mjs`: isolated HTTP tests using a fake database.
- `../server.js`: **approved** router import and mount at `/ticketing`.

No migration, seed, frontend, authentication, or other module files were changed.

## API

All paths begin `/ticketing/tenants/:tenantId` and require a signed-in session and membership in an active tenant.

- `GET/POST /inboxes`
- `GET/POST /tickets`
- `GET /tickets/:ticketId`
- `GET/POST /tickets/:ticketId/assignments`
- `POST /tickets/:ticketId/acknowledge`
- `PATCH /tickets/:ticketId/status`
- `GET/POST /tickets/:ticketId/comments`
- `GET /tickets/:ticketId/activity`
- `GET/PUT /tickets/:ticketId/story-points`
- `GET/POST /tickets/:ticketId/verifications`
- `POST /tickets/:ticketId/verifications/:verificationId/revoke`
- `GET /work-summary/:userId?from=YYYY-MM-DD&to=YYYY-MM-DD`

Request bodies use camelCase. Successful responses use `{ "data": ... }`; ticketing validation errors use `{ "error": { "code", "message", "requestId" } }`.

Tenant `owner`/`admin` members can manage inboxes, assign tickets, close/cancel, set estimates, and verify/revoke work. Ordinary members can create their own tickets, read tickets they created/requested or are actively assigned to, comment, and update assigned work. Only the assigned employee can acknowledge. Internal comments are visible only to tenant managers and the current assignee. A work summary is visible to its employee, a tenant manager, or a user whose global role has `TICKET_HR_READ` permission. The latter permission is a future integration hook; it is not currently present in the database and was **not** seeded.

Ticketing mutations write ticket activity and an audit entry in the same transaction. Verification requires a resolved ticket, an assignment record, a positive estimate, a different verifier, and available unverified points. Story points represent estimated work complexity, not pay or an automatic HR decision.

Inbox records provide the helpdesk address and ticket association. Inbound email ingestion and outbound email delivery are **not** implemented here because no agreed provider/webhook contract was supplied. No Finance or automatic HR decision workflow is implemented.

## Verification

Run `node --experimental-test-module-mocks --test src/ticketing/ticketing.test.mjs`. The test app uses a fake pool and makes no database changes.
