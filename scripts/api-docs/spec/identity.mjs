import { err, paging, pagination, tenantParam } from './common.mjs';

const user = { id: 12, email: 'jane@example.com', username: 'janedoe', fullName: 'Jane Doe', roleId: 3 };
const invitation = { id: '5', email: 'sam@example.com', role: 'member', status: 'pending', expiresAt: '2026-11-05T09:00:00.000Z', createdAt: '2026-10-29T09:00:00.000Z', invitedByUserId: '12' };
const sessionOnly = { session: true, permission: null, tenantRole: null };
const publicAuth = (notes) => ({ session: false, permission: null, tenantRole: null, notes });
const idle = { sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.' };
const invalidCode = err.identity(400, 'OTP_INVALID', 'That code is not correct.', 'Wrong code. Also `OTP_EXPIRED`, `OTP_LOCKED` (5 wrong attempts: request a new code) and `OTP_ALREADY_USED` (sign-in challenge already completed).');
const limited = err.coded(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', 'Per-IP rate limit.');
const managerAuth = (extra) => ({ session: true, permission: null, tenantRole: `owner or admin${extra ? `; ${extra}` : ''}`, notes: 'Re-checked inside the transaction under a tenant lock.' });
const inviteNotFound = err.identity(404, 'INVITATION_NOT_FOUND', 'Invitation not found.', 'No such invitation in this tenant.');
const invitationParam = { name: 'invitation_id', type: 'positive integer', desc: 'Invitation ID within the tenant.', example: '{{invitationId}}' };

export const identityAuth = [
    {
        key: 'auth.signup', folder: 'Authentication', name: 'Sign up', method: 'POST', path: '/auth/signup/',
        purpose: 'Registers an account in the unverified state and emails a 6-digit verification code. No session is created and the account cannot sign in until the address is verified (**Verify email**). The answer is the same whether or not the address is already registered.',
        auth: publicAuth('Public. Rate limited to 5 requests per hour per IP.'),
        prereq: ['Collection variables `signupFullName`, `signupUsername`, `signupEmail`, `signupPassword` (the pre-request script fills the username/email; set `signupPassword` in your environment, never in the collection).'],
        preRequest: [
            "const stamp = Date.now().toString(36).slice(-8);",
            "if (!pm.collectionVariables.get('signupUsername')) pm.collectionVariables.set('signupUsername', 'qa' + stamp);",
            "if (!pm.collectionVariables.get('signupEmail')) pm.collectionVariables.set('signupEmail', 'qa+' + stamp + '@example.test');",
        ],
        body: {
            fields: [
                { name: 'fullName', type: 'string', required: true, rules: '2-100 characters: letters (any script), single spaces, hyphens, apostrophes, periods.' },
                { name: 'username', type: 'string', required: true, rules: '3-20 letters/digits, single spaces between words. Unique case-insensitively.' },
                { name: 'email', type: 'string', required: true, rules: 'Valid email, max 254 characters; trimmed and lower-cased; unique case-insensitively.' },
                { name: 'password', type: 'string', required: true, rules: '8-20 characters, no whitespace, lower + upper + digit + symbol, at most 72 UTF-8 bytes.' },
            ],
            example: { fullName: '{{signupFullName}}', username: '{{signupUsername}}', email: '{{signupEmail}}', password: '{{signupPassword}}' },
            invalid: [{ example: { fullName: 'X', username: 'ab', email: 'nope', password: 'weak' }, status: 400, note: 'Validation message names the first failing rule.' }],
        },
        responses: [
            { status: 202, note: 'Always for a valid request (new address, existing unverified address, or an address that already has an account).', body: { status: 'verification_sent', codeLength: 6, retryAfterSeconds: 60, message: 'If the details are valid, a verification code has been sent to the email address. Enter it to activate the account.' } },
            err.plain(400, 'Username must be 3 to 20 alphanumeric characters.', 'Validation failure (`Enter your full name ...`, `A valid email address is required.`, password rules, ...).'),
            err.identity(409, 'USERNAME_TAKEN', 'That username is already taken. Choose another.', 'Only username conflicts are explicit; email conflicts are not revealed.'),
            { status: 429, note: 'Signup rate limit (default text body).', body: 'Too many requests, please try again later.' },
        ],
        sideEffects: ['Inserts an unverified `users` row (bcrypt hash), a hashed `verify_email` challenge and a `SIGNUP` audit row in one transaction; then sends the code by email.', 'A second registration for an unverified address never replaces the stored password; for a verified address an "account exists" notice is emailed (at most one per 10 minutes).'],
        audit: '`SIGNUP` (table `users`, transactional; no email or credentials in the entry).',
        repeat: 'Yes: repeats give the same 202 and at most one code per 60 seconds.',
        tests: ["pm.test('generic acceptance', () => pm.expect(pm.response.json().status).to.eql('verification_sent'));"],
    },
    {
        key: 'auth.verifyEmail', folder: 'Authentication', name: 'Verify email', method: 'POST', path: '/auth/verify-email',
        purpose: 'Submits the 6-digit code from the verification email. On success the account becomes active and receives the `standard` account role (which allows creating an organization). The caller must still sign in.',
        auth: publicAuth('Public. Rate limited to 20 requests per 15 minutes per IP; each code also allows 5 wrong attempts.'),
        prereq: ['**Sign up** first; set `verificationCode` to the code from the email (in development with `MAIL_TRANSPORT=outbox` read it from `.mail-outbox/`).'],
        body: {
            fields: [{ name: 'email', type: 'string', required: true, rules: 'The registered address.' }, { name: 'code', type: 'string', required: true, rules: 'Exactly 6 digits.' }],
            example: { email: '{{signupEmail}}', code: '{{verificationCode}}' },
            invalid: [{ example: { email: '{{signupEmail}}', code: '000000' }, status: 400, note: '`OTP_INVALID` (the counter of wrong attempts increases).' }],
        },
        responses: [{ status: 200, note: 'Verified.', body: { status: 'verified', message: 'Email verified. You can sign in now.' } }, invalidCode, limited],
        sideEffects: ['Sets `email_verified_at`, assigns the `standard` role if the user had none, consumes the challenge, audits.'],
        audit: '`SIGNUP_VERIFIED`; failures: `EMAIL_VERIFY_FAILED` (reason only, never the code).',
        repeat: 'No: a used code cannot be replayed.',
        tests: ["pm.test('verified or documented refusal', () => pm.expect([200, 400]).to.include(pm.response.code));"],
        expectedStatuses: [200, 400],
    },
    {
        key: 'auth.verifyEmail.resend', folder: 'Authentication', name: 'Resend verification code', method: 'POST', path: '/auth/verify-email/resend',
        purpose: 'Sends a fresh verification code (superseding the previous one). Always answers 202 so it cannot be used to discover which addresses are registered.',
        auth: publicAuth('Public. 10 requests per hour per IP; a 60-second cooldown and 5 codes per hour per account apply silently.'),
        body: { fields: [{ name: 'email', type: 'string', required: true, rules: 'Address to resend to.' }], example: { email: '{{signupEmail}}' }, invalid: [] },
        responses: [{ status: 202, note: 'Always.', body: { status: 'verification_sent', codeLength: 6, retryAfterSeconds: 60, message: 'If that address has an unverified account, a new code has been sent.' } }, limited],
        sideEffects: ['Supersedes the live challenge and emails a new one (only for an existing unverified account outside the cooldown).'], audit: 'None.', repeat: 'Yes (cooldown applies).',
        tests: ["pm.test('generic acceptance', () => pm.expect(pm.response.json().status).to.eql('verification_sent'));"],
    },
    {
        key: 'auth.login', folder: 'Authentication', name: 'Log in', method: 'POST', path: '/auth/login/',
        purpose: 'Authenticates with email and password. Success starts a session (HttpOnly `bean.sid`, regenerated on login). Unverified accounts are refused. A browser that is not a trusted device for the account must first pass an emailed code: the response is 202 and **no session exists** until **Complete sign-in** succeeds.',
        auth: publicAuth('Public. Rate limited: 3 failed attempts per 15 minutes per IP and 10 per account.'),
        prereq: ['A verified account. Set `userEmail` and `userPassword` in your environment (never commit them).'],
        body: {
            fields: [{ name: 'email', type: 'string', required: true, rules: 'Trimmed, lower-cased, max 254 characters.' }, { name: 'password', type: 'string', required: true, rules: 'Non-empty, at most 72 UTF-8 bytes.' }],
            example: { email: '{{userEmail}}', password: '{{userPassword}}' },
            invalid: [{ example: { email: 'jane@example.com' }, status: 400, note: 'Email and password are required.' }],
        },
        responses: [
            { status: 200, note: 'Signed in; sets `bean.sid`. The first successful sign-in of an account also sets the `bean.dev.<userId>` trusted-device cookie (one per account).', body: { message: 'Login successful.', user } },
            { status: 202, note: 'Step-up required (device not yet trusted). No session cookie is set.', body: { challenge: 'email_otp', challengeId: '3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10', codeLength: 6, retryAfterSeconds: 60, expiresInMinutes: 10, message: 'Enter the code we emailed you to finish signing in.' } },
            err.plain(400, 'Email and password are required.', 'Missing or oversized credentials.'),
            err.plain(401, 'Invalid email or password.', 'Unknown, disabled or wrong-password account (identical for all).'),
            err.identity(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to sign in.', 'Correct password but the address is unverified.'),
            err.identity(429, 'OTP_RATE_LIMITED', 'A code was just sent. Wait a moment before requesting another.', 'Step-up code requested twice within 60 seconds (has `Retry-After`). Also the rate-limit 429s.'),
        ],
        sideEffects: ['Creates a session (200) or a hashed `login_step_up` challenge plus an emailed code (202).', 'Audits success, failure for existing accounts, and step-up requests.'],
        audit: '`LOGIN_SUCCESS`, `LOGIN_FAILURE`, `LOGIN_STEP_UP_REQUIRED` (table `session`, account level).', repeat: 'Yes (failures count toward the limiter).',
        notes: ['The expected status is 200 or 202 depending on whether this Postman client already holds a trusted-device cookie.'],
        tests: ["pm.test('signed in or step-up', () => pm.expect([200, 202]).to.include(pm.response.code));", "if (pm.response.code === 202) pm.collectionVariables.set('loginChallengeId', pm.response.json().challengeId);", "if (pm.response.code === 200) pm.collectionVariables.set('currentUserId', String(pm.response.json().user.id));"],
        expectedStatuses: [200, 202],
    },
    {
        key: 'auth.login.verify', folder: 'Authentication', name: 'Complete sign-in (emailed code)', method: 'POST', path: '/auth/login/verify',
        purpose: 'Finishes a step-up sign-in with the code from the email. On success the session is created (ID regenerated) and this browser becomes a trusted device.',
        auth: publicAuth('Public. 20 requests per 15 minutes per IP; 5 wrong attempts per code.'),
        prereq: ['A 202 from **Log in** (`loginChallengeId`) and the emailed code in `loginCode`.'],
        body: {
            fields: [{ name: 'challengeId', type: 'string (UUID)', required: true, rules: 'The `challengeId` from the 202 login response.' }, { name: 'code', type: 'string', required: true, rules: '6 digits.' }],
            example: { challengeId: '{{loginChallengeId}}', code: '{{loginCode}}' }, invalid: [{ example: { challengeId: 'x', code: '1' }, status: 400, note: '`OTP_INVALID`.' }],
        },
        responses: [{ status: 200, note: 'Signed in; sets `bean.sid` and `bean.dev.<userId>`.', body: { message: 'Login successful.', user } }, invalidCode, limited],
        sideEffects: ['Consumes the challenge, regenerates the session, registers the trusted device.'], audit: '`LOGIN_SUCCESS` (with `stepUp: email_otp`); failures `LOGIN_STEP_UP_FAILED`.', repeat: 'No: codes are single use.',
        tests: ["pm.test('signed in or documented refusal', () => pm.expect([200, 400]).to.include(pm.response.code));"], expectedStatuses: [200, 400],
    },
    {
        key: 'auth.me', folder: 'Authentication', name: 'Current user', method: 'GET', path: '/auth/me',
        purpose: 'Returns the signed-in, verified account and its account-level permissions. Use it to restore UI state after a reload.',
        auth: { ...sessionOnly, notes: 'Any signed-in, enabled, email-verified account.' }, prereq: ['Run **Log in** first.'],
        responses: [{ status: 200, note: '`Cache-Control: no-store`.', body: { user: { ...user, emailVerified: true, permissions: ['TENANTS_CREATE'] } } }, err.unauthenticated, err.sessionExpired],
        ...idle, tests: ["pm.test('permissions is an array', () => pm.expect(pm.response.json().user.permissions).to.be.an('array'));"],
    },
    {
        key: 'onboarding.get', folder: 'Authentication', name: 'Onboarding state', method: 'GET', path: '/onboarding',
        purpose: 'Where the user is in the guided flow, derived from real records (nothing is stored, so it is resumable from any device): `organization` = no organization yet (create one or accept an invitation); `done` = belongs to at least one organization.',
        auth: sessionOnly, prereq: ['Run **Log in** first.'],
        responses: [{ status: 200, note: '`Cache-Control: no-store`.', body: { data: { step: 'organization', organizations: 0, pendingInvitations: 1, canCreateOrganization: true } } }, err.unauthenticated],
        ...idle, tests: ["pm.test('step present', () => pm.expect(pm.response.json().data.step).to.be.oneOf(['organization', 'done']));"],
    },
    {
        key: 'auth.password.forgot', folder: 'Authentication', name: 'Request password reset', method: 'POST', path: '/auth/password/forgot',
        purpose: 'Emails a single-use reset link (token in the URL fragment, valid 60 minutes). Always answers 202 so it cannot reveal which addresses have accounts.',
        auth: publicAuth('Public. 10 requests per hour per IP; a 60-second cooldown and 5 links per hour per account apply silently.'),
        body: { fields: [{ name: 'email', type: 'string', required: true, rules: 'Account address.' }], example: { email: '{{userEmail}}' }, invalid: [] },
        responses: [{ status: 202, note: 'Always.', body: { status: 'reset_requested', retryAfterSeconds: 60, message: 'If that address has an account, a reset link has been sent.' } }, limited],
        sideEffects: ['Supersedes any live reset token and stores only its hash; emails the link.'], audit: '`PASSWORD_RESET_REQUESTED`.', repeat: 'Yes (throttled).',
        tests: ["pm.test('generic acceptance', () => pm.expect(pm.response.json().status).to.eql('reset_requested'));"],
    },
    {
        key: 'auth.password.reset', folder: 'Authentication', name: 'Reset password', method: 'POST', path: '/auth/password/reset',
        purpose: 'Sets a new password using the emailed token. The token works once, expires after 60 minutes, ends every session of the account, forgets trusted devices, verifies the address if still unverified, and notifies the owner by email.',
        auth: publicAuth('Public. 10 requests per 15 minutes per IP.'), prereq: ['`resetToken` from the `#token=` fragment of the emailed link.'],
        body: {
            fields: [{ name: 'token', type: 'string', required: true, rules: 'From the link.' }, { name: 'newPassword', type: 'string', required: true, rules: 'Same rules as signup.' }],
            example: { token: '{{resetToken}}', newPassword: '{{newPassword}}' }, invalid: [{ example: { token: 'x', newPassword: 'weak' }, status: 400, note: '`INVALID_PASSWORD`.' }],
        },
        responses: [
            { status: 200, note: 'Changed.', body: { status: 'password_reset', message: 'Your password was changed. Sign in with the new password.' } },
            err.identity(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Request a new one.', 'Unknown, used or expired token. Weak passwords give `INVALID_PASSWORD`.'), limited,
        ],
        sideEffects: ['Updates `password_hash` / `password_changed_at`, deletes all the user\'s sessions and trusted devices, consumes the token.'], audit: '`PASSWORD_RESET_COMPLETED` (number of sessions revoked).', repeat: 'No: single use.',
        tests: ["pm.test('reset or documented refusal', () => pm.expect([200, 400]).to.include(pm.response.code));"], expectedStatuses: [200, 400],
    },
    {
        key: 'auth.emailChange.request', folder: 'Authentication', name: 'Request email change', method: 'POST', path: '/auth/email-change/request',
        purpose: 'Starts changing the sign-in email: proves the current password, emails a code to the NEW address and a notice to the old one. Nothing changes until the code is confirmed. The answer is the same if the new address is already registered.',
        auth: { ...sessionOnly, notes: '10 requests per hour per user.' }, prereq: ['Signed in; `newEmail` variable.'],
        body: {
            fields: [{ name: 'newEmail', type: 'string', required: true, rules: 'Valid email, max 254.' }, { name: 'currentPassword', type: 'string', required: true, rules: 'The account password.' }],
            example: { newEmail: '{{newEmail}}', currentPassword: '{{userPassword}}' }, invalid: [{ example: { newEmail: 'x' }, status: 400, note: '`INVALID_REQUEST`.' }],
        },
        responses: [
            { status: 202, note: 'Code sent if the address can be used.', body: { status: 'code_sent', codeLength: 6, retryAfterSeconds: 60, message: 'If the address can be used, a confirmation code has been sent to it.' } },
            err.identity(400, 'INVALID_REQUEST', 'Enter a valid new email address and your current password.', 'Validation.'), err.unauthenticated,
            err.identity(403, 'INVALID_PASSWORD', 'Your current password is not correct.', 'Wrong password (audited).'),
            err.identity(429, 'OTP_RATE_LIMITED', 'A code was just sent. Wait a moment before requesting another.', 'Cooldown (has `Retry-After`).'),
        ],
        sideEffects: ['Supersedes a previous email-change challenge; emails the code to the new address and a notice to the current one.'], audit: '`EMAIL_CHANGE_REQUESTED`, `EMAIL_CHANGE_DENIED`.', repeat: 'Yes (cooldown).',
        tests: ["pm.test('accepted', () => pm.expect(pm.response.json().status).to.eql('code_sent'));"],
    },
    {
        key: 'auth.emailChange.confirm', folder: 'Authentication', name: 'Confirm email change', method: 'POST', path: '/auth/email-change/confirm',
        purpose: 'Completes the change with the code sent to the new address. Updates the email, ends the user\'s OTHER sessions (this one stays), and notifies the old address.',
        auth: { ...sessionOnly, notes: '20 requests per 15 minutes per IP; 5 wrong attempts per code.' }, prereq: ['`emailChangeCode` from the new address.'],
        body: { fields: [{ name: 'code', type: 'string', required: true, rules: '6 digits.' }], example: { code: '{{emailChangeCode}}' }, invalid: [] },
        responses: [
            { status: 200, note: 'Changed.', body: { status: 'email_changed', message: 'Your email address was changed.', email: 'new@example.com' } },
            invalidCode, err.unauthenticated, err.identity(409, 'EMAIL_UNAVAILABLE', 'That email address can no longer be used. Start again with another address.', 'Registered by someone else meanwhile.'),
        ],
        sideEffects: ['Updates `users.email`, revokes other sessions, consumes the challenge.'], audit: '`EMAIL_CHANGE_CONFIRMED`.', repeat: 'No: single use.',
        tests: ["pm.test('changed or documented refusal', () => pm.expect([200, 400, 409]).to.include(pm.response.code));"], expectedStatuses: [200, 400, 409],
    },
];

export const tenantIdentity = [
    {
        key: 'tenants.invitations.list', folder: 'Tenants', name: 'List invitations', method: 'GET', path: '/tenants/:tenant_id/invitations',
        purpose: 'Lists the organization\'s invitations, newest first (paginated). `expired` is derived from the expiry time.',
        auth: managerAuth(), pathParams: [tenantParam()],
        query: [{ name: 'status', type: 'enum', desc: '`pending` (default), `expired`, `accepted`, `revoked` or `all`.', example: 'pending' }, ...paging], prereq: ['`tenantId`.'],
        responses: [{ status: 200, note: 'Page of invitations.', body: { message: 'Invitations retrieved successfully.', data: [invitation], pagination } }, err.unauthenticated, err.badPaging,
            err.identity(400, 'INVALID_FILTER', 'Unknown status filter.', 'Bad `status`.'), err.coded(403, 'TENANT_ROLE_REQUIRED', 'This action requires one of these tenant roles: owner, admin.', 'Plain member.'), err.coded(404, 'TENANT_NOT_FOUND', 'Tenant not found.', 'Not a member.')],
        ...idle, tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
        capture: [{ variable: 'invitationId', expr: 'json.data.length ? json.data[0].id : undefined', onlyIfUnset: true }],
    },
    {
        key: 'tenants.invitations.create', folder: 'Tenants', name: 'Invite a teammate', method: 'POST', path: '/tenants/:tenant_id/invitations',
        purpose: 'Invites an email address to the organization. Only an account that has verified that exact address can accept. A new invitation replaces an older pending one for the same address. The email contains a link with a 256-bit token (stored only as a hash).',
        auth: managerAuth('admins may invite only `member`; owners any role'), pathParams: [tenantParam()], prereq: ['`tenantId`; `invitationEmail` variable. Rate limited to 60 per hour per user.'],
        body: {
            fields: [{ name: 'email', type: 'string', required: true, rules: 'Valid email; not your own; not already a member.' }, { name: 'role', type: 'string', required: false, rules: '`member` (default), `admin` or `owner` (owners only for admin/owner).' }],
            example: { email: '{{invitationEmail}}', role: 'member' }, invalid: [{ example: { email: 'x', role: 'god' }, status: 400, note: '`INVALID_INVITATION`.' }],
        },
        responses: [
            { status: 201, note: 'Created and emailed (valid 7 days).', body: { message: 'Invitation sent.', data: invitation } },
            err.unauthenticated, err.identity(400, 'INVALID_INVITATION', 'Provide a valid email address and an optional role (owner, admin, member).', 'Validation or self-invite.'),
            err.coded(403, 'OWNER_REQUIRED', 'Only tenant owners can invite someone as an owner or administrator.', 'Also `TENANT_ROLE_REQUIRED`.'), err.coded(404, 'TENANT_NOT_FOUND', 'Tenant not found.', 'Not a member.'),
            err.coded(409, 'ALREADY_MEMBER', 'That person is already a member of this organization.', 'Also `INVITATION_LIMIT` (100 pending), `TENANT_INACTIVE`.'), err.coded(429, 'RATE_LIMITED', 'Too many invitations sent. Try again later.', 'Hourly cap.'),
        ],
        sideEffects: ['Revokes a previous pending invitation for the address, inserts the new one, emails it (after commit).'], audit: '`CREATE INVITATION` (tenant-scoped, masked email, no token).', repeat: 'Yes: re-inviting replaces the pending invitation.',
        tests: ["pm.test('pending invitation', () => pm.expect(pm.response.json().data.status).to.eql('pending'));"], capture: [{ variable: 'invitationId', expr: 'json.data.id' }],
    },
    {
        key: 'tenants.invitations.resend', folder: 'Tenants', name: 'Resend invitation', method: 'POST', path: '/tenants/:tenant_id/invitations/:invitation_id/resend',
        purpose: 'Issues a new token and a fresh 7-day expiry for a pending invitation and emails it; the previous link stops working.',
        auth: managerAuth(), pathParams: [tenantParam(), invitationParam], prereq: ['`invitationId` of a pending invitation.'], body: null, bodyNote: 'No request body.',
        responses: [{ status: 200, note: 'Resent.', body: { message: 'Invitation resent.', data: invitation } }, err.unauthenticated, err.coded(403, 'OWNER_REQUIRED', 'Only tenant owners can manage this invitation.', 'Admin touching an admin/owner invitation.'), inviteNotFound,
            err.coded(409, 'INVITATION_NOT_PENDING', 'Only pending invitations can be resent.', 'Already accepted/revoked/expired.'), err.coded(429, 'RESEND_COOLDOWN', 'This invitation was just sent. Wait a moment before resending.', '60-second cooldown.')],
        sideEffects: ['Replaces the token hash and expiry; emails the new link.'], audit: '`RESEND INVITATION`.', repeat: 'Yes after the cooldown.',
        tests: ["pm.test('resent or documented refusal', () => pm.expect([200, 409, 429]).to.include(pm.response.code));"], expectedStatuses: [200, 409, 429],
    },
    {
        key: 'tenants.invitations.revoke', folder: 'Tenants', name: 'Revoke invitation', method: 'DELETE', path: '/tenants/:tenant_id/invitations/:invitation_id',
        purpose: 'Cancels a pending invitation; its link stops working immediately.',
        auth: managerAuth(), pathParams: [tenantParam(), invitationParam], prereq: ['`invitationId` of a pending invitation.'],
        responses: [{ status: 200, note: 'Revoked.', body: { message: 'Invitation revoked.', data: { id: '5', status: 'revoked' } } }, err.unauthenticated, err.coded(403, 'OWNER_REQUIRED', 'Only tenant owners can manage this invitation.', 'Admin touching an admin/owner invitation.'), inviteNotFound,
            err.coded(409, 'INVITATION_NOT_PENDING', 'Only pending invitations can be revoked.', 'Not pending.')],
        sideEffects: ['Sets status `revoked`.'], audit: '`REVOKE INVITATION`.', repeat: 'No: a second call returns 409.',
        tests: ["pm.test('revoked or documented refusal', () => pm.expect([200, 409]).to.include(pm.response.code));"], expectedStatuses: [200, 409],
    },
    {
        key: 'tenants.ownership.request', folder: 'Tenants', name: 'Request ownership transfer', method: 'POST', path: '/tenants/:tenant_id/ownership-transfer/request',
        purpose: 'First step of handing the organization to another member: emails the current owner a confirmation code (step-up). Nothing changes yet.',
        auth: { session: true, permission: null, tenantRole: 'owner', notes: 'Tenant must be active.' }, pathParams: [tenantParam()], prereq: ['`tenantId`; `newOwnerUserId` of an active member other than yourself.'],
        body: { fields: [{ name: 'newOwnerUserId', type: 'ID', required: true, rules: 'An active member of this tenant; no other keys.' }], example: { newOwnerUserId: '{{newOwnerUserId}}' }, invalid: [{ example: {}, status: 400, note: '`INVALID_TRANSFER`.' }] },
        responses: [{ status: 202, note: 'Code emailed to the owner.', body: { status: 'code_sent', codeLength: 6, retryAfterSeconds: 60, message: 'We emailed you a confirmation code. Enter it to complete the transfer.' } }, err.unauthenticated,
            err.identity(400, 'INVALID_TRANSFER', 'Provide the user ID of an existing member as newOwnerUserId.', 'Validation or self-transfer.'), err.coded(403, 'OWNER_REQUIRED', 'Only tenant owners can transfer ownership.', 'Not an owner.'),
            err.identity(404, 'MEMBER_NOT_FOUND', 'The new owner must be an active member of this organization.', 'Target not an active member.'), err.identity(429, 'OTP_RATE_LIMITED', 'A code was just sent. Wait a moment before requesting another.', 'Cooldown (has `Retry-After`).')],
        sideEffects: ['Issues a hashed `sensitive_action` challenge bound to this tenant and target; emails the code.'], audit: '`OWNERSHIP_TRANSFER_REQUESTED`.', repeat: 'Yes (cooldown; supersedes the previous code).',
        tests: ["pm.test('code sent', () => pm.expect(pm.response.json().status).to.eql('code_sent'));"],
    },
    {
        key: 'tenants.ownership.confirm', folder: 'Tenants', name: 'Confirm ownership transfer', method: 'POST', path: '/tenants/:tenant_id/ownership-transfer/confirm',
        purpose: 'Completes the transfer with the emailed code: in one transaction the new owner becomes `owner` and the caller becomes `admin`. A code issued for another tenant or action is rejected.',
        auth: { session: true, permission: null, tenantRole: 'owner', notes: 'Re-checked under the tenant lock.' }, pathParams: [tenantParam()], prereq: ['`transferCode` from the email.'],
        body: { fields: [{ name: 'code', type: 'string', required: true, rules: '6 digits.' }], example: { code: '{{transferCode}}' }, invalid: [] },
        responses: [{ status: 200, note: 'Transferred.', body: { message: 'Ownership transferred. You are now an administrator of this organization.', data: { tenantId: '4', newOwnerUserId: '15', yourRole: 'admin' } } }, invalidCode, err.unauthenticated,
            err.coded(403, 'OWNER_REQUIRED', 'Only tenant owners can transfer ownership.', 'Not (or no longer) an owner.'), err.identity(409, 'MEMBER_NOT_FOUND', 'The new owner is no longer an active member of this organization.', 'Target left meanwhile.')],
        sideEffects: ['Promotes the target, demotes the caller, consumes the code; exactly one owner remains.'], audit: '`OWNERSHIP_TRANSFERRED` (tenant-scoped, old and new owner).', repeat: 'No: single use, and the caller is no longer an owner afterwards.',
        tests: ["pm.test('transferred or documented refusal', () => pm.expect([200, 400, 403, 409]).to.include(pm.response.code));"], expectedStatuses: [200, 400, 403, 409],
    },
];

export const invitations = [
    {
        key: 'invitations.preview', folder: 'Invitations', name: 'Preview invitation (token)', method: 'POST', path: '/invitations/preview',
        purpose: 'Shows what an invitation token is for before the person signs in (organization, role, inviter, masked address, expiry). Public: the 256-bit token is the credential. Reveals nothing else.',
        auth: publicAuth('Public. 30 requests per 15 minutes per IP.'), prereq: ['`invitationToken` from the `#token=` fragment of the emailed link.'],
        body: { fields: [{ name: 'token', type: 'string', required: true, rules: 'From the link (sent in the body, never in a URL).' }], example: { token: '{{invitationToken}}' }, invalid: [{ example: { token: 'x' }, status: 400, note: '`INVALID_INVITATION`.' }] },
        responses: [
            { status: 200, note: 'Valid, pending, unexpired invitation to an active organization. `Cache-Control: no-store`.', body: { data: { organization: 'Acme Coffee', role: 'member', invitedBy: 'Jane Doe', emailHint: 's***@example.com', expiresAt: '2026-11-05T09:00:00.000Z' } } },
            err.identity(400, 'INVALID_INVITATION', 'This invitation is invalid, expired, or was already used.', 'Unknown, used, expired or revoked (indistinguishable).'), limited,
        ],
        sideEffects: ['None.'], audit: 'None (read-only).', repeat: 'Yes.',
        tests: ["pm.test('preview or documented refusal', () => pm.expect([200, 400]).to.include(pm.response.code));"], expectedStatuses: [200, 400],
    },
    {
        key: 'invitations.mine', folder: 'Invitations', name: 'My pending invitations', method: 'GET', path: '/invitations/mine',
        purpose: 'Pending, unexpired invitations addressed to the signed-in user\'s verified email address (for the onboarding screen).',
        auth: sessionOnly, prereq: ['Signed in.'],
        responses: [{ status: 200, note: 'Possibly empty.', body: { message: 'Invitations retrieved successfully.', data: [{ id: '5', organization: 'Acme Coffee', role: 'member', invitedBy: 'Jane Doe', expiresAt: '2026-11-05T09:00:00.000Z' }] } }, err.unauthenticated],
        ...idle, tests: ["pm.test('data array', () => pm.expect(pm.response.json().data).to.be.an('array'));"],
        capture: [{ variable: 'invitationId', expr: 'json.data.length ? json.data[0].id : undefined', onlyIfUnset: true }],
    },
    {
        key: 'invitations.accept', folder: 'Invitations', name: 'Accept invitation (token)', method: 'POST', path: '/invitations/accept',
        purpose: 'Accepts an invitation using the token from the emailed link. The signed-in account must be verified and its email must equal the invited address. The membership is created and the token consumed in one transaction; concurrent attempts create one membership.',
        auth: { ...sessionOnly, notes: '20 requests per 15 minutes per user.' }, prereq: ['`invitationToken` from the `#token=` fragment of the link.'],
        body: { fields: [{ name: 'token', type: 'string', required: true, rules: 'From the link (sent in the body, never in a URL).' }], example: { token: '{{invitationToken}}' }, invalid: [{ example: { token: 'x' }, status: 400, note: '`INVALID_INVITATION`.' }] },
        responses: [
            { status: 200, note: 'Joined (or already a member, which closes the invitation).', body: { message: 'Invitation accepted.', data: { tenantId: '4', name: 'Acme Coffee', membershipRole: 'member', alreadyMember: false } } },
            err.unauthenticated, err.identity(400, 'INVALID_INVITATION', 'This invitation is invalid, expired, or was already used.', 'Unknown, used, revoked or deleted-tenant invitation.'),
            err.identity(403, 'INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address. Sign in with that address to accept it.', 'Wrong account.'),
            err.identity(409, 'INVITATION_NO_LONGER_VALID', 'The person who invited you can no longer add members. Ask for a new invitation.', 'Inviter lost authority. Also `TENANT_INACTIVE`.'),
            err.identity(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask for a new one.', 'Past the 7-day expiry.'),
        ],
        sideEffects: ['Inserts `tenant_members`, marks the invitation accepted (after re-checking inviter authority and tenant status under a tenant lock).'], audit: '`ADD TENANT MEMBER` (via invitation) and `ACCEPT INVITATION` (tenant-scoped).', repeat: 'No: single use.',
        tests: ["pm.test('accepted or documented refusal', () => pm.expect([200, 400, 403, 409, 410]).to.include(pm.response.code));"], expectedStatuses: [200, 400, 403, 409, 410],
    },
    {
        key: 'invitations.acceptById', folder: 'Invitations', name: 'Accept invitation (from my list)', method: 'POST', path: '/invitations/:invitation_id/accept',
        purpose: 'Accepts one of the invitations from **My pending invitations** without the email token. The same email-match, authority and transaction rules apply.',
        auth: { ...sessionOnly, notes: '20 requests per 15 minutes per user.' }, pathParams: [invitationParam], prereq: ['`invitationId` from **My pending invitations**.'], body: null, bodyNote: 'No request body.',
        responses: [
            { status: 200, note: 'Joined.', body: { message: 'Invitation accepted.', data: { tenantId: '4', name: 'Acme Coffee', membershipRole: 'member', alreadyMember: false } } },
            err.unauthenticated, err.identity(400, 'INVALID_INVITATION', 'This invitation is invalid, expired, or was already used.', 'Not addressed to this account, used or revoked (indistinguishable).'),
            err.identity(409, 'INVITATION_NO_LONGER_VALID', 'The person who invited you can no longer add members. Ask for a new invitation.', 'Also `TENANT_INACTIVE`.'), err.identity(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask for a new one.', 'Expired.'),
        ],
        sideEffects: ['Same as **Accept invitation (token)**.'], audit: '`ADD TENANT MEMBER`, `ACCEPT INVITATION`.', repeat: 'No: single use.',
        tests: ["pm.test('accepted or documented refusal', () => pm.expect([200, 400, 409, 410]).to.include(pm.response.code));"], expectedStatuses: [200, 400, 409, 410],
    },
];
