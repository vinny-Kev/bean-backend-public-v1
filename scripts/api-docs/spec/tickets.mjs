import { err, tenantParam, ticketParam } from './common.mjs';

const ticket = {
    id: '7', tenantId: '4', ticketNumber: '13', title: 'Printer broken', description: 'The label printer jams.', ticketType: 'support', status: 'open', priority: 'medium',
    requesterUserId: '12', inboxId: null, assignedToUserId: null, createdByUserId: '12', parentTicketId: null, dueAt: null, acknowledgedAt: null, resolvedAt: null,
    closedAt: null, createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z',
};
const verification = {
    id: '3', ticketId: '7', contributorUserId: '15', verifiedPoints: '3.00', verifiedByUserId: '12', verificationStatus: 'verified', verificationNotes: null,
    verifiedAt: '2026-10-20T09:00:00.000Z', revokedAt: null, revokedByUserId: null,
};
const tp = () => tenantParam('tenantId');
const notMember = err.ticket(404, 'Tenant not found.', 'Not a member of the tenant, or the tenant is deleted or nonexistent (indistinguishable on purpose).', 'TENANT_NOT_FOUND');
const inactive = err.ticket(409, 'This tenant is not active.', 'The caller is a member but the tenant is not active.', 'TENANT_INACTIVE');
const badId = err.ticket(400, 'A valid ticket ID is required.', 'Malformed ID (also `A valid tenant ID is required.`, etc.).');
const noTicket = err.ticket(404, 'Ticket not found.', 'Missing, in another tenant, or not visible to a non-manager caller (deliberately indistinguishable).');
const managerOnly = err.ticket(403, 'Tenant owner or admin access is required.', 'Plain members cannot perform this action.');
const common = [err.unauthenticated, notMember, inactive];
const ticketAuth = (role) => ({ session: true, permission: null, tenantRole: role, notes: 'Ticketing uses tenant membership (active tenant) instead of account-level permissions. `owner` and `admin` are "managers".' });
const mutating = { repeat: 'No: changes state each call.' };

export const tickets = [
    {
        key: 'tickets.inboxes.list', folder: 'Tickets', name: 'List inboxes', method: 'GET', path: '/ticketing/tenants/:tenantId/inboxes',
        purpose: 'Lists the tenant\'s helpdesk inboxes (name, address, description). Managers see inactive inboxes too.',
        auth: ticketAuth('any member'), pathParams: [tp()], prereq: ['`tenantId`.'],
        responses: [{ status: 200, note: 'Array (possibly empty).', body: { data: [{ id: '1', tenantId: '4', name: 'Support', email: 'support@acme.test', description: null, isActive: true, createdByUserId: '12', createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' }] } }, ...common],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
        capture: [{ variable: 'inboxId', expr: 'json.data.length ? json.data[0].id : undefined', onlyIfUnset: true }],
    },
    {
        key: 'tickets.inboxes.create', folder: 'Tickets', name: 'Create inbox', method: 'POST', path: '/ticketing/tenants/:tenantId/inboxes',
        purpose: 'Registers a helpdesk inbox address that tickets can be associated with. Email ingestion/delivery is not implemented.',
        auth: ticketAuth('owner or admin'), pathParams: [tp()], prereq: ['`tenantId`.'],
        preRequest: ["pm.collectionVariables.set('inboxEmail', 'help-' + Date.now().toString(36) + '@example.test');"],
        body: {
            fields: [
                { name: 'name', type: 'string', required: true, rules: '1-150 characters.' },
                { name: 'email', type: 'string', required: true, rules: 'Valid email, max 320 characters; lower-cased; unique per tenant.' },
                { name: 'description', type: 'string', required: false, rules: 'Max 2000 characters.' },
            ],
            example: { name: 'Support', email: '{{inboxEmail}}', description: 'Customer support inbox' },
            invalid: [{ example: { name: 'Support', email: 'nope' }, status: 400, note: 'A valid inbox email is required.' }],
        },
        responses: [
            { status: 201, note: 'Created.', body: { data: { id: '1', tenantId: '4', name: 'Support', email: 'support@acme.test', description: null, isActive: true, createdByUserId: '12', createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' } } },
            ...common, managerOnly,
            err.ticket(400, 'A valid inbox email is required.', 'Validation failure.'),
            err.ticket(409, 'An inbox with this email already exists.', 'Duplicate address in the tenant.'),
        ],
        sideEffects: ['Inserts a `ticket_inboxes` row.', 'Writes a `TICKET_INBOX_CREATE` audit entry in the same transaction.'],
        audit: '`TICKET_INBOX_CREATE` (table `ticket_inboxes`, tenant-scoped, transactional).', repeat: 'No with a fixed address (409); the pre-request script generates a unique one.',
        tests: ["pm.test('inbox created', () => pm.expect(pm.response.json().data.isActive).to.be.true);"],
        capture: [{ variable: 'inboxId', expr: 'json.data.id' }],
    },
    {
        key: 'tickets.list', folder: 'Tickets', name: 'List tickets', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets',
        purpose: 'Lists tickets newest first. Managers see every ticket in the tenant; other members only tickets they requested, created, or are/were actively assigned to.',
        auth: ticketAuth('any member'), pathParams: [tp()],
        query: [
            { name: 'page', type: 'integer', desc: '1-based page (default 1).', example: '1' },
            { name: 'limit', type: 'integer', desc: '1 to 20 (default 20).', example: '20' },
            { name: 'status', type: 'enum', desc: '`open`, `acknowledged`, `in_progress`, `pending`, `resolved`, `closed`, `cancelled`.', example: 'open' },
            { name: 'ticketType', type: 'enum', desc: '`support`, `task`, `hr_task`, `bug`, `incident`.', example: 'support' },
        ],
        prereq: ['`tenantId`.'],
        responses: [
            { status: 200, note: 'Flat `{ data, pagination }`, like every other list endpoint.', body: { data: [ticket], pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false } } },
            ...common, err.ticket(400, 'Invalid pagination.', 'Bad `page`/`limit`; invalid `status` / `ticket type` filters also return 400.'),
        ],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('list and pagination', () => { const b = pm.response.json(); pm.expect(b.data).to.be.an('array'); pm.expect(b.pagination).to.have.property('total'); });"],
    },
    {
        key: 'tickets.create', folder: 'Tickets', name: 'Create ticket', method: 'POST', path: '/ticketing/tenants/:tenantId/tickets',
        purpose: 'Opens a ticket (status `open`). Plain members can only raise tickets for themselves; managers may set another tenant member as requester.',
        auth: ticketAuth('any member (managers only for `requesterUserId` ≠ self)'), pathParams: [tp()], prereq: ['`tenantId`; optional `inboxId`.'],
        body: {
            fields: [
                { name: 'title', type: 'string', required: true, rules: '1-250 characters after trimming.' },
                { name: 'description', type: 'string', required: false, rules: 'Max 10000 characters.' },
                { name: 'ticketType', type: 'string', required: false, rules: '`support` (default), `task`, `hr_task`, `bug`, `incident`.' },
                { name: 'priority', type: 'string', required: false, rules: '`low`, `medium` (default), `high`, `urgent`.' },
                { name: 'inboxId', type: 'ID', required: false, rules: 'Active inbox in this tenant.' },
                { name: 'parentTicketId', type: 'ID', required: false, rules: 'A ticket the caller can read in this tenant.' },
                { name: 'requesterUserId', type: 'ID', required: false, rules: 'Active tenant member; default is the caller; others need manager role.' },
                { name: 'dueAt', type: 'string (ISO-8601)', required: false, rules: 'Parseable date-time; stored as UTC.' },
            ],
            example: { title: 'Printer broken', description: 'The label printer jams.', ticketType: 'support', priority: 'medium' },
            invalid: [{ example: { description: 'no title' }, status: 400, note: 'Title must be 1 to 250 characters.' }],
        },
        responses: [
            { status: 201, note: 'Created with a per-tenant `ticketNumber`.', body: { data: ticket } },
            ...common,
            err.ticket(400, 'Title must be 1 to 250 characters.', 'Validation failure (also `Invalid ticket type.`, `Invalid priority.`, `Invalid due date.`, `Inbox not found for this tenant.`, `The selected user is not an active tenant member.`).'),
            err.ticket(403, 'You can only create tickets for yourself.', 'Member set another requester.'),
            err.ticket(404, 'Ticket not found.', 'Unreadable or missing `parentTicketId`.'),
        ],
        sideEffects: ['Inserts a `tickets` row and a `created` `ticket_activity` row.', 'Writes a `TICKET_CREATE` audit entry; all three commit or roll back together.'],
        audit: '`TICKET_CREATE` (table `tickets`, tenant-scoped, transactional).', repeat: 'No: every call opens another ticket (no duplicate-submission guard).',
        tests: ["pm.test('opened', () => pm.expect(pm.response.json().data.status).to.eql('open'));"],
        capture: [{ variable: 'ticketId', expr: 'json.data.id' }],
    },
    {
        key: 'tickets.get', folder: 'Tickets', name: 'Get ticket', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets/:ticketId',
        purpose: 'Returns one ticket the caller may read (manager, requester, creator, assignee or past/current assignee).',
        auth: ticketAuth('manager, or involved member'), pathParams: [tp(), ticketParam], prereq: ['`ticketId` (run **Create ticket**).'],
        responses: [{ status: 200, note: 'Found.', body: { data: ticket } }, ...common, badId, noTicket],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('ticket id matches', () => pm.expect(String(pm.response.json().data.id)).to.eql(String(pm.collectionVariables.get('ticketId'))));"],
    },
    {
        key: 'tickets.assignments.list', folder: 'Tickets', name: 'List assignments', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/assignments',
        purpose: 'Assignment history of a ticket, newest first (current assignment has `unassignedAt: null`). Notes are only shown to managers.',
        auth: ticketAuth('manager, or involved member'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        responses: [{ status: 200, note: 'Array.', body: { data: [{ id: '2', userId: '15', assignedByUserId: '12', isPrimary: true, assignedAt: '2026-10-20T09:05:00.000Z', unassignedAt: null, notes: 'Please take this.' }] } }, ...common, badId, noTicket],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
    },
    {
        key: 'tickets.assignments.create', folder: 'Tickets', name: 'Assign ticket', method: 'POST', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/assignments',
        purpose: 'Assigns (or reassigns) the ticket to an active tenant member. The previous primary assignment is closed. Assigning the current assignee again is a no-op.',
        auth: ticketAuth('owner or admin'), pathParams: [tp(), ticketParam],
        prereq: ['`ticketId`; `memberUserId` set to an active tenant member (run **Add member** or **List members**).'],
        body: {
            fields: [
                { name: 'userId', type: 'ID', required: true, rules: 'Active tenant member.' },
                { name: 'notes', type: 'string', required: false, rules: 'Max 2000 characters.' },
            ],
            example: { userId: '{{memberUserId}}', notes: 'Please take this.' },
            invalid: [{ example: { notes: 'x' }, status: 400, note: 'A valid assignee user ID is required.' }],
        },
        responses: [
            { status: 200, note: 'Returns the updated ticket.', body: { data: { ...ticket, assignedToUserId: '15' } } },
            ...common, managerOnly, badId, noTicket,
            err.ticket(400, 'The selected user is not an active tenant member.', 'Also `A valid assignee user ID is required.`'),
            err.ticket(409, 'This ticket cannot be assigned.', 'Ticket is resolved, closed or cancelled.'),
        ],
        sideEffects: ['Closes the open assignment row, inserts a new primary one and updates `assigned_to_user_id`.', 'Writes an `assigned` activity row and a `TICKET_ASSIGN` audit entry (not written when the assignee is unchanged).'],
        audit: '`TICKET_ASSIGN` (table `tickets`, tenant-scoped, transactional).', repeat: 'Yes: re-assigning the same user changes nothing and writes no audit entry.',
        notes: ['Known gap: reassigning an already acknowledged ticket keeps status `acknowledged`, so the new assignee cannot acknowledge it (acknowledge requires `open`).'],
        tests: ["pm.test('assignee set', () => pm.expect(pm.response.json().data.assignedToUserId).to.be.a('string'));"],
    },
    {
        key: 'tickets.acknowledge', folder: 'Tickets', name: 'Acknowledge ticket', method: 'POST', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/acknowledge',
        purpose: 'The assigned employee confirms they have picked up the ticket (`open` → `acknowledged`).',
        auth: ticketAuth('the assigned employee only (managers are not exempt)'), pathParams: [tp(), ticketParam],
        prereq: ['Signed in as the current assignee of an `open` ticket.'], body: null, bodyNote: 'No request body.',
        responses: [
            { status: 200, note: 'Acknowledged.', body: { data: { ...ticket, status: 'acknowledged', assignedToUserId: '15', acknowledgedAt: '2026-10-20T09:10:00.000Z' } } },
            ...common, badId, noTicket,
            err.ticket(403, 'Only the assigned employee can acknowledge this ticket.', 'Caller is not the assignee.'),
            err.ticket(409, 'Ticket cannot be acknowledged now.', 'Not `open`, or already acknowledged.'),
        ],
        sideEffects: ['Sets status `acknowledged` and `acknowledged_at`.', 'Writes an `acknowledged` activity row and a `TICKET_ACKNOWLEDGE` audit entry.'],
        audit: '`TICKET_ACKNOWLEDGE` (table `tickets`, tenant-scoped, transactional).', repeat: 'No: a second call returns 409.',
        notes: ['Expected statuses 200 (as assignee) or 403/409 otherwise; the sample test accepts those outcomes because the collection user is usually the manager.'],
        tests: ["pm.test('acknowledged or refused', () => pm.expect([200, 403, 409]).to.include(pm.response.code));"],
        expectedStatuses: [200, 403, 409],
    },
    {
        key: 'tickets.status', folder: 'Tickets', name: 'Change ticket status', method: 'PATCH', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/status',
        purpose: 'Moves the ticket along its workflow. Allowed transitions: open → acknowledged | in_progress | cancelled; acknowledged → in_progress | pending | resolved | cancelled; in_progress → pending | resolved | cancelled; pending → in_progress | resolved | cancelled; resolved → in_progress | closed; closed and cancelled are terminal.',
        auth: ticketAuth('manager or the current assignee; `closed` and `cancelled` need a manager'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        body: {
            fields: [{ name: 'status', type: 'string', required: true, rules: 'One of the seven statuses and a legal transition from the current one.' }],
            example: { status: 'in_progress' }, invalid: [{ example: { status: 'done' }, status: 400, note: 'Invalid status.' }],
        },
        responses: [
            { status: 200, note: 'Returns the updated ticket (`resolvedAt` / `closedAt` set accordingly).', body: { data: { ...ticket, status: 'in_progress' } } },
            ...common, badId, noTicket,
            err.ticket(400, 'Invalid status.', 'Unknown status value or non-object body.'),
            err.ticket(403, 'Only managers or the assigned employee can change status.', 'Also `Tenant owner or admin access is required.` for close/cancel.'),
            err.ticket(409, 'Invalid ticket status transition.', 'Also `Revoke verified work before reopening this ticket.`'),
        ],
        sideEffects: ['Updates status and timestamps under a row lock.', 'Writes a `status_changed` activity row and a `TICKET_STATUS` audit entry.'],
        audit: '`TICKET_STATUS` (table `tickets`, tenant-scoped, transactional).', repeat: 'No: repeating the same status is an invalid transition (409).',
        tests: ["pm.test('status changed or transition refused', () => pm.expect([200, 409]).to.include(pm.response.code));"],
        expectedStatuses: [200, 409],
    },
    {
        key: 'tickets.comments.list', folder: 'Tickets', name: 'List comments', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/comments',
        purpose: 'Comments in chronological order. Internal notes are shown only to managers and the current assignee.',
        auth: ticketAuth('manager, or involved member'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        responses: [{ status: 200, note: 'Array.', body: { data: [{ id: '1', authorUserId: '12', body: 'On it.', isInternal: false, createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' }] } }, ...common, badId, noTicket],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
    },
    {
        key: 'tickets.comments.create', folder: 'Tickets', name: 'Add comment', method: 'POST', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/comments',
        purpose: 'Adds a public comment, or an internal note when `isInternal` is true.',
        auth: ticketAuth('manager, or involved member (internal notes: manager or assignee only)'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        body: {
            fields: [
                { name: 'body', type: 'string', required: true, rules: '1-10000 characters after trimming.' },
                { name: 'isInternal', type: 'boolean', required: false, rules: 'Default false.' },
            ],
            example: { body: 'Looking into it.', isInternal: false }, invalid: [{ example: { body: '' }, status: 400, note: 'Comment must be 1 to 10000 characters.' }],
        },
        responses: [
            { status: 201, note: 'Created.', body: { data: { id: '1', authorUserId: '12', body: 'Looking into it.', isInternal: false, createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' } } },
            ...common, badId, noTicket,
            err.ticket(400, 'Comment must be 1 to 10000 characters.', 'Also `isInternal must be a boolean.`'),
            err.ticket(403, 'Only managers or assignees can post internal comments.', 'Requester tried an internal note.'),
        ],
        sideEffects: ['Inserts a `ticket_comments` row and a `comment_added` activity row.', 'Writes a `TICKET_COMMENT` audit entry.'],
        audit: '`TICKET_COMMENT` (table `tickets`, tenant-scoped, transactional; the comment text is not copied into the audit entry).', repeat: 'No: each call adds a comment.',
        tests: ["pm.test('comment stored', () => pm.expect(pm.response.json().data.body).to.be.a('string'));"],
    },
    {
        key: 'tickets.activity', folder: 'Tickets', name: 'Ticket activity history', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/activity',
        purpose: 'Chronological activity (created, assigned, status changes, comments, estimates, verifications). Internal-comment events are hidden from non-managers who are not the assignee.',
        auth: ticketAuth('manager, or involved member'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        responses: [{ status: 200, note: 'Array.', body: { data: [{ id: '1', actorUserId: '12', activityType: 'created', fieldName: null, oldValue: null, newValue: { ticketType: 'support', status: 'open' }, metadata: {}, createdAt: '2026-10-20T09:00:00.000Z' }] } }, ...common, badId, noTicket],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
    },
    {
        key: 'tickets.storyPoints.get', folder: 'Tickets', name: 'Get story-point estimate', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/story-points',
        purpose: 'Returns the ticket\'s effort estimate, or `data: null` when none is set.',
        auth: ticketAuth('manager, or involved member'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        responses: [{ status: 200, note: '`data` is `null` when no estimate exists.', body: { data: { id: '1', ticketId: '7', estimatedPoints: '5.00', estimatedByUserId: '12', estimateNotes: null, createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' } } }, ...common, badId, noTicket],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('object or null', () => pm.expect(pm.response.json()).to.have.property('data'));"],
    },
    {
        key: 'tickets.storyPoints.set', folder: 'Tickets', name: 'Set story-point estimate', method: 'PUT', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/story-points',
        purpose: 'Creates or replaces the ticket\'s effort estimate. Story points are effort, not pay or a performance rating.',
        auth: ticketAuth('owner or admin'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        body: {
            fields: [
                { name: 'estimatedPoints', type: 'number | numeric string', required: true, rules: '0 to 9999.99, at most two decimals.' },
                { name: 'estimateNotes', type: 'string', required: false, rules: 'Max 2000 characters.' },
            ],
            example: { estimatedPoints: 5, estimateNotes: 'Needs a part replaced.' }, invalid: [{ example: { estimatedPoints: -1 }, status: 400, note: 'Estimated points must be at most 9999.99 with two decimal places.' }],
        },
        responses: [
            { status: 200, note: 'Upserted.', body: { data: { id: '1', ticketId: '7', estimatedPoints: '5.00', estimatedByUserId: '12', estimateNotes: null, createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' } } },
            ...common, managerOnly, badId, noTicket,
            err.ticket(400, 'Estimated points must be at most 9999.99 with two decimal places.', 'Validation failure.'),
            err.ticket(409, 'This ticket cannot be estimated now.', 'Ticket closed/cancelled; also `Estimate cannot be below already verified points.`'),
        ],
        sideEffects: ['Upserts `ticket_story_points` under a row lock.', 'Writes an `estimate_changed` activity row and a `TICKET_ESTIMATE` audit entry.'],
        audit: '`TICKET_ESTIMATE` (table `tickets`, tenant-scoped, transactional).', repeat: 'Yes (upsert; each call adds activity/audit rows).',
        tests: ["pm.test('estimate stored', () => pm.expect(pm.response.json().data.estimatedPoints).to.be.a('string'));"],
    },
    {
        key: 'tickets.verifications.list', folder: 'Tickets', name: 'List work verifications', method: 'GET', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/verifications',
        purpose: 'Verified (and revoked) contribution records. Managers see all; others see only their own.',
        auth: ticketAuth('manager, or involved member'), pathParams: [tp(), ticketParam], prereq: ['`ticketId`.'],
        responses: [{ status: 200, note: 'Array.', body: { data: [verification] } }, ...common, badId, noTicket],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
        capture: [{ variable: 'verificationId', expr: 'json.data.length ? json.data[0].id : undefined', onlyIfUnset: true }],
    },
    {
        key: 'tickets.verifications.create', folder: 'Tickets', name: 'Verify work', method: 'POST', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/verifications',
        purpose: 'A manager verifies a contributor\'s completed work, crediting points up to the ticket\'s estimate.',
        auth: ticketAuth('owner or admin (not the contributor)'), pathParams: [tp(), ticketParam],
        prereq: ['A `resolved` or `closed` ticket with a positive estimate and the contributor having been assigned at some point.'],
        body: {
            fields: [
                { name: 'contributorUserId', type: 'ID', required: true, rules: 'Active tenant member who was assigned to the ticket; not the caller.' },
                { name: 'verifiedPoints', type: 'number | numeric string', required: true, rules: 'Greater than 0, at most 9999.99 (two decimals); total verified cannot exceed the estimate.' },
                { name: 'verificationNotes', type: 'string', required: false, rules: 'Max 2000 characters.' },
            ],
            example: { contributorUserId: '{{memberUserId}}', verifiedPoints: 3, verificationNotes: 'Printer fixed and tested.' },
            invalid: [{ example: { contributorUserId: '{{currentUserId}}', verifiedPoints: 3 }, status: 403, note: 'Work cannot be self-verified.' }],
        },
        responses: [
            { status: 201, note: 'Verified.', body: { data: verification } },
            ...common, managerOnly, badId, noTicket,
            err.ticket(400, 'Verified points must be greater than zero and at most 9999.99 with two decimal places.', 'Validation failure.'),
            err.ticket(403, 'Work cannot be self-verified.', 'Contributor equals the caller.'),
            err.ticket(409, 'Resolve the ticket before verifying work.', 'Also: `Only assigned contributors can receive verified points.`, `This contribution is already verified.`, `A positive estimate is required before verification.`, `Verified points exceed the ticket estimate.`'),
        ],
        sideEffects: ['Inserts `ticket_work_verifications`, a `work_verified` activity row and a `TICKET_VERIFY` audit entry in one transaction.'],
        audit: '`TICKET_VERIFY` (table `tickets`, tenant-scoped, transactional).', repeat: 'No: a contribution can only be verified once until revoked (409).',
        notes: ['Needs a resolved ticket with an estimate and assignment; on a bare dataset the sample test accepts the documented 409/403 refusals.'],
        tests: ["pm.test('verified or documented refusal', () => pm.expect([201, 400, 403, 409]).to.include(pm.response.code));"],
        expectedStatuses: [201, 400, 403, 409],
        capture: [{ variable: 'verificationId', expr: 'json.data && json.data.id', requireStatus: 201 }],
    },
    {
        key: 'tickets.verifications.revoke', folder: 'Tickets', name: 'Revoke verification', method: 'POST', path: '/ticketing/tenants/:tenantId/tickets/:ticketId/verifications/:verificationId/revoke',
        purpose: 'Revokes a previously verified contribution (for example, after a mistake), freeing the points again.',
        auth: ticketAuth('owner or admin'),
        pathParams: [tp(), ticketParam, { name: 'verificationId', type: 'positive integer (bigint)', desc: 'Verification ID (from **List work verifications** or **Verify work**).', example: '{{verificationId}}' }],
        prereq: ['`ticketId` and a `verificationId` that is still `verified`.'], body: null, bodyNote: 'No request body.',
        responses: [
            { status: 200, note: 'Revoked.', body: { data: { ...verification, verificationStatus: 'revoked', revokedAt: '2026-10-21T09:00:00.000Z', revokedByUserId: '12' } } },
            ...common, managerOnly, badId, noTicket,
            err.ticket(404, 'Verification not found.', 'Wrong ID or ticket.'),
            err.ticket(409, 'Verification is already revoked.', 'Already revoked.'),
        ],
        sideEffects: ['Marks the verification `revoked`.', 'Writes a `verification_revoked` activity row and a `TICKET_VERIFY_REVOKE` audit entry.'],
        audit: '`TICKET_VERIFY_REVOKE` (table `tickets`, tenant-scoped, transactional).', repeat: 'No: a second call returns 409.',
        tests: ["pm.test('revoked or documented refusal', () => pm.expect([200, 404, 409]).to.include(pm.response.code));"],
        expectedStatuses: [200, 404, 409],
    },
    {
        key: 'tickets.workSummary', folder: 'Tickets', name: 'Employee work summary', method: 'GET', path: '/ticketing/tenants/:tenantId/work-summary/:userId',
        purpose: 'Counts of resolved tickets and verified points for one employee, optionally within a date range. A decision-support figure, not a performance rating.',
        auth: ticketAuth('the employee themself, a manager, or a user whose account role has `TICKET_HR_READ`'),
        pathParams: [tp(), { name: 'userId', type: 'positive integer (bigint)', desc: 'Employee (tenant member) to summarise.', example: '{{currentUserId}}' }],
        query: [
            { name: 'from', type: 'date `YYYY-MM-DD`', desc: 'Inclusive start (UTC).', example: '2026-10-01' },
            { name: 'to', type: 'date `YYYY-MM-DD`', desc: 'Inclusive end (UTC); not before `from`.', example: '2026-10-31' },
        ],
        prereq: ['`tenantId` and a `userId`. `TICKET_HR_READ` is not seeded by any migration, so in practice only the employee or a manager can read a summary.'],
        responses: [
            { status: 200, note: 'Summary.', body: { data: { tenantId: '4', userId: '15', period: { from: '2026-10-01', to: '2026-10-31' }, resolvedTicketCount: 2, verifiedTicketCount: 1, verifiedPoints: '3.00', note: 'Story points are estimated effort, not a performance rating or compensation decision.' } } },
            ...common,
            err.ticket(400, 'Invalid from date. Use YYYY-MM-DD.', 'Bad date or `From date must not be after to date.`'),
            err.ticket(403, 'HR work-summary permission is required.', 'Asking for someone else without being a manager.'),
            err.ticket(404, 'Employee not found in this tenant.', 'User is not a member.'),
        ],
        sideEffects: ['None.'], audit: 'None (read-only; access to HR-style summaries is not audited, see the QA report).', repeat: 'Yes.',
        tests: ["pm.test('counts present', () => pm.expect(pm.response.json().data).to.have.property('verifiedPoints'));"],
    },
];

export { mutating };
