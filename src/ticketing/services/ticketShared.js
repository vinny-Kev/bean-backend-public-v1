import { pool } from "../../db/pool.js";

export class TicketError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => {
  throw new TicketError(status, message);
};
export const objectBody = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "A JSON object is required.");
  return value;
};
export const idValue = (value, label = "ID") => {
  const text = String(value ?? "");
  if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) {
    fail(400, `A valid ${label} is required.`);
  }
  return text;
};
export const optionalId = (value, label) =>
  value == null ? null : idValue(value, label);
export const textValue = (value, label, max, required = false) => {
  if (value == null && !required) return null;
  if (typeof value !== "string") fail(400, `${label} must be text.`);
  const text = value.trim();
  if ((required && !text) || text.length > max)
    fail(400, `${label} must be 1 to ${max} characters.`);
  return text || null;
};
export const enumValue = (value, values, label) => {
  if (!values.includes(value)) fail(400, `Invalid ${label}.`);
  return value;
};
export const pointsValue = (value, label, positive = false) => {
  const text = String(value ?? "");
  if (
    !/^\d{1,4}(?:\.\d{1,2})?$/.test(text) ||
    (positive && Number(text) === 0)
  ) {
    fail(
      400,
      `${label} must be ${positive ? "greater than zero and " : ""}at most 9999.99 with two decimal places.`,
    );
  }
  return text;
};
export const dateValue = (value, label) => {
  if (value == null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    fail(400, `Invalid ${label}.`);
  return new Date(value).toISOString();
};

export const withTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const tenantAccess = async (req, _res, next) => {
  try {
    const tenantId = idValue(req.params.tenantId, "tenant ID");
    const result = await pool.query(
      `
            SELECT tm.membership_role
            FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
            WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND t.status = 'active'
        `,
      [tenantId, req.user.id],
    );
    if (!result.rows[0])
      fail(403, "You are not a member of this active tenant.");
    const role = result.rows[0].membership_role;
    req.ticketAccess = {
      tenantId,
      userId: String(req.user.id),
      role,
      manager: role === "owner" || role === "admin",
    };
    next();
  } catch (error) {
    next(error);
  }
};

export const requireManager = (access) => {
  if (!access.manager) fail(403, "Tenant owner or admin access is required.");
};
export const ensureTenantUser = async (client, tenantId, userId) => {
  const result = await client.query(
    `
        SELECT 1 FROM tenant_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = $1 AND tm.user_id = $2
          AND u.is_disabled = false AND u.deleted_at IS NULL
    `,
    [tenantId, userId],
  );
  if (!result.rows[0])
    fail(400, "The selected user is not an active tenant member.");
};
export const ticketRow = async (client, access, ticketId, lock = false) => {
  const result = await client.query(
    `
        SELECT * FROM tickets WHERE tenant_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}
    `,
    [access.tenantId, ticketId],
  );
  if (!result.rows[0]) fail(404, "Ticket not found.");
  return result.rows[0];
};
export const isAssignee = (access, row) =>
  String(row.assigned_to_user_id) === access.userId;
export const canReadTicket = async (client, access, row) => {
  if (
    access.manager ||
    isAssignee(access, row) ||
    String(row.requester_user_id) === access.userId ||
    String(row.created_by_user_id) === access.userId
  )
    return true;
  const result = await client.query(
    `
        SELECT 1 FROM ticket_assignments
        WHERE tenant_id = $1 AND ticket_id = $2 AND user_id = $3 AND unassigned_at IS NULL
    `,
    [access.tenantId, row.id, access.userId],
  );
  return Boolean(result.rows[0]);
};
export const requireTicketReader = async (client, access, row) => {
  if (!(await canReadTicket(client, access, row)))
    fail(404, "Ticket not found.");
};
export const recordActivity = async (
  client,
  access,
  ticketId,
  type,
  field = null,
  oldValue = null,
  newValue = null,
  metadata = {},
) => {
  await client.query(
    `
        INSERT INTO ticket_activity
            (tenant_id, ticket_id, actor_user_id, activity_type, field_name, old_value, new_value, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
    `,
    [
      access.tenantId,
      ticketId,
      access.userId,
      type,
      field,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      JSON.stringify(metadata),
    ],
  );
};
export const recordAudit = async (
  client,
  access,
  recordId,
  action,
  newData = null,
  tableName = "tickets",
) => {
  await client.query(
    `
        INSERT INTO audit_logs (user_id, action, table_name, record_id, new_data)
        VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      access.userId,
      action,
      tableName,
      recordId,
      newData == null ? null : JSON.stringify(newData),
    ],
  );
};
export const presentTicket = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  ticketNumber: row.ticket_number,
  title: row.title,
  description: row.description,
  ticketType: row.ticket_type,
  status: row.status,
  priority: row.priority,
  requesterUserId: row.requester_user_id,
  inboxId: row.inbox_id,
  assignedToUserId: row.assigned_to_user_id,
  createdByUserId: row.created_by_user_id,
  parentTicketId: row.parent_ticket_id,
  dueAt: row.due_at,
  acknowledgedAt: row.acknowledged_at,
  resolvedAt: row.resolved_at,
  closedAt: row.closed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
