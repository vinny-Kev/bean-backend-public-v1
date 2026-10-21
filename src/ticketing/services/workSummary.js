import { pool } from "../../db/pool.js";
import { fail, idValue } from "./ticketShared.js";

const periodDate = (value, label) => {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    fail(400, `Invalid ${label}. Use YYYY-MM-DD.`);
  }
  return value;
};

export async function workSummary(access, rawUserId, query) {
  const userId = idValue(rawUserId, "user ID");
  const from = periodDate(query.from, "from date");
  const to = periodDate(query.to, "to date");
  if (from && to && from > to)
    fail(400, "From date must not be after to date.");
  if (!access.manager && userId !== access.userId) {
    const allowed = await pool.query(
      `
            SELECT 1 FROM users u
            JOIN role_permissions rp ON rp.role_id = u.role_id
            JOIN permissions p ON p.id = rp.permission_id
            WHERE u.id = $1 AND p.name = 'TICKET_HR_READ'
        `,
      [access.userId],
    );
    if (!allowed.rows[0]) fail(403, "HR work-summary permission is required.");
  }
  const member = await pool.query(
    `
        SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2
    `,
    [access.tenantId, userId],
  );
  if (!member.rows[0]) fail(404, "Employee not found in this tenant.");
  const [work, verified] = await Promise.all([
    pool.query(
      `
            SELECT COUNT(DISTINCT t.id)::int AS resolved_ticket_count
            FROM tickets t JOIN ticket_assignments a
              ON a.tenant_id = t.tenant_id AND a.ticket_id = t.id
            WHERE t.tenant_id = $1 AND a.user_id = $2
              AND t.status IN ('resolved','closed')
              AND a.assigned_at <= t.resolved_at
              AND (a.unassigned_at IS NULL OR a.unassigned_at >= t.resolved_at)
              AND ($3::date IS NULL OR t.resolved_at >= $3::date)
              AND ($4::date IS NULL OR t.resolved_at < ($4::date + INTERVAL '1 day'))
        `,
      [access.tenantId, userId, from, to],
    ),
    pool.query(
      `
            SELECT COUNT(DISTINCT ticket_id)::int AS verified_ticket_count,
              COALESCE(SUM(verified_points),0)::text AS verified_points
            FROM ticket_work_verifications
            WHERE tenant_id = $1 AND contributor_user_id = $2
              AND verification_status = 'verified'
              AND ($3::date IS NULL OR verified_at >= $3::date)
              AND ($4::date IS NULL OR verified_at < ($4::date + INTERVAL '1 day'))
        `,
      [access.tenantId, userId, from, to],
    ),
  ]);
  return {
    tenantId: access.tenantId,
    userId,
    period: { from, to },
    resolvedTicketCount: work.rows[0].resolved_ticket_count,
    verifiedTicketCount: verified.rows[0].verified_ticket_count,
    verifiedPoints: verified.rows[0].verified_points,
    note: "Story points are estimated effort, not a performance rating or compensation decision.",
  };
}
