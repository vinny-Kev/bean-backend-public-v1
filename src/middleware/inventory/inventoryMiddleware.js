import { pool } from "../../db/pool.js";
import { compareToPattern, inRangeOfLength } from "../../util/validations.js";
import { composeAuditLogs } from "../../audit_logs/auditLogService.js";
import { auditLog } from "../../audit_logs/auditLog.js";


export const inventoryMiddleware = async (req, res, next) => {
  try {
    console.log(
      "[INVENTORY MIDDLEWARE]: Start Process - Inventory middleware.",
    );
    const { name, unit } = req.body;

    const rawSku = req.body.sku;
    const sku = typeof rawSku === "string" ? rawSku.trim().toUpperCase() : null;

    const rawQuantity = req.body.quantity;
    const quantity =
      rawQuantity === undefined ? undefined : Number(rawQuantity);

    if (!name || typeof name !== "string" || !name.trim()) {
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "EMPTY/NULL ITEM NAME",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

      console.log(
        "[INVENTORY MIDDLEWARE]: End Process - Empty/null inventory name.",
      );
      return res.status(400).json({ message: "Invalid inventory name." });
    }

    if (
      !compareToPattern(name, "alphanumeric") ||
      !inRangeOfLength(name, 3, 50)
    ) {
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID INVENTORY ITEM NAME",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

      console.log(
        "[INVENTORY MIDDLEWARE]: End Process - Item name must be alphanumeric and between 3 to 50 characters.",
      );
      return res.status(400).json({
        message:
          "Inventory name must be alphanumeric and between 3 to 50 characters.",
      });
    }

    if (!sku) {
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "NULL/EMPTY INVENTORY SKU VALUE",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

      console.log(
        "[INVENTORY MIDDLEWARE]: End Process - Null/empty inventory SKU value.",
      );
      return res.status(400).json({ message: "Invalid inventory SKU." });
    }

    if (!compareToPattern(sku, "sku") || !inRangeOfLength(sku, 3, 20)) {
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID SKU VALUE",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);

      console.log("[INVENTORY MIDDLEWARE]: End Process - Invalid SKU.");
      return res.status(400).json({ message: "Invalid SKU." });
    }

    if (
      quantity !== undefined &&
      (!Number.isInteger(quantity) || quantity < 0)
    ) {
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID QUANTITY VALUE",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);

      console.log(
        "[INVENTORY MIDDLEWARE]: End Process - Invalid inventory quantity.",
      );
      return res.status(400).json({ message: "Invalid inventory quantity." });
    }

    const duplicateCheckQuery =
      "SELECT EXISTS (SELECT 1 FROM inventory where sku = $1) AS exists";
    const duplicateCheckResult = await pool.query(duplicateCheckQuery, [sku]);
    if (duplicateCheckResult.rows[0].exists) {
      console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "DUPLICATE INVENTORY ITEM",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);

      console.log("[INVENTORY MIDDLEWARE]: End Process - Item already exists.");

      return res
        .status(400)
        .json({ message: "Inventory item with this SKU already exists." });
    }

    req.body = {
      ...req.body,
      quantity,
      sku,
    };

    return next();
  } catch (error) {
    console.error(
      "[INVENTORY MIDDLEWARE]: End Process - Error during inventory middleware:",
      error,
    );
    return res
      .status(500)
      .json({ message: "Internal server error during inventory middleware." });
  }
};

export const updateInventoryMiddleware = async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body ?? {};

    if (!id || !compareToPattern(id, "item_id")) {
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID INVENTORY ITEM ID",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: body,
      });
      await composeAuditLogs(auditEntry);
      return res.status(400).json({
        message: "Invalid inventory item ID.",
      });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";

    const sku =
      typeof body.sku === "string" ? body.sku.trim().toUpperCase() : "";

    const unit = typeof body.unit === "string" ? body.unit.trim() : "";

    const rawQuantity = body.quantity;
    const quantity = Number(rawQuantity);

    if (
      !name ||
      !compareToPattern(name, "alphanumeric") ||
      !inRangeOfLength(name, 3, 50)
    ) {
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID INVENTORY ITEM ID",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      return res.status(400).json({
        message:
          "Inventory name must be alphanumeric and between 3 and 50 characters.",
      });
    }

    if (!sku || !compareToPattern(sku, "sku") || !inRangeOfLength(sku, 3, 20)) {
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID INVENTORY ITEM",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      return res.status(400).json({
        message: "Invalid inventory SKU.",
      });
    }

    if (
      rawQuantity === undefined ||
      rawQuantity === null ||
      rawQuantity === "" ||
      !Number.isInteger(quantity) ||
      quantity < 0
    ) {
      return res.status(400).json({
        message: "Quantity must be a non-negative integer.",
      });
    }

    if (!unit || !inRangeOfLength(unit, 1, 50)) {
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID INVENTORY ITEM QUANTITY",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      return res.status(400).json({
        message: "Unit must be between 1 and 50 characters.",
      });
    }

    const existingItem = await pool.query(
      "SELECT id FROM inventory WHERE id = $1",
      [id],
    );

    if (existingItem.rowCount === 0) {
      const auditEntry = auditLog({
        userId: req.user.id,
        action: "INVALID INVENTORY ITEM ID",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      return res.status(404).json({
        message: "Inventory item not found.",
      });
    }

    // Exclude the item being edited from the duplicate-SKU check.
    const duplicateSku = await pool.query(
      `SELECT 1
             FROM inventory
             WHERE sku = $1 AND id <> $2
             LIMIT 1`,
      [sku, id],
    );

    if (duplicateSku.rowCount > 0) {
        const auditEntry = auditLog({
        userId: req.user.id,
        action: "DUPLICATE INVENTORY ITEM SKU",
        tableName: "inventory",
        recordId: null,
        oldData: null,
        newData: { name, quantity, unit, sku },
      });
      await composeAuditLogs(auditEntry);
      return res.status(409).json({
        message: "Another inventory item already uses this SKU.",
      });
    }

    req.body = {
      name,
      sku,
      quantity,
      unit,
    };

    return next();
  } catch (error) {
    console.error("[INVENTORY UPDATE MIDDLEWARE]:", error);

    return res.status(500).json({
      message: "Internal server error during inventory validation.",
    });
  }
};
