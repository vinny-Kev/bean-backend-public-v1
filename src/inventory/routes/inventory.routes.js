import express from "express";

const router = express.Router();
import { sessionAuthMiddleware } from "../../middleware/auth/sessionAuthMiddleware.js";
import { requirePermission } from "../../middleware/auth/permissionMiddleware.js";
import {readInventoryService,addInvetoryItemService,updateInventoryItemService,} from "../services/inventoryService.js";
import {inventoryMiddleware,updateInventoryMiddleware,} from "../../middleware/inventory/inventoryMiddleware.js";
import { log } from "../../util/breadcrumb.js";
import { paginationMiddleware } from "../../middleware/fetch/paginationMiddleware.js";

router.get("/health/", (req, res) => {
  log("INVENTORY_HEALTH", "INVENTORY ROUTE START");
  res.json({ message: "Inventory route is working!" });
});

router.get(
  "/all/",
  log("INVENTORY_READ", "INVENTORY ROUTE START"),
  sessionAuthMiddleware,
  log("INVENTORY_READ", "SESSION MIDDLEWARE PASSED - USER AUTHENTICATED"),
  requirePermission("INVENTORY_READ"),
  log("INVENTORY_READ", "PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION"),
  paginationMiddleware,
  readInventoryService,
);

router.post("/add/",
  log("INVENTORY_ADD", "INVENTORY ROUTE START"),
  sessionAuthMiddleware,
  log("INVENTORY_ADD", "SESSION MIDDLEWARE PASSED - USER AUTHENTICATED"),
  requirePermission("INVENTORY_CREATE"),
  log("INVENTORY_ADD", "PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION"),
  inventoryMiddleware,
  log("INVENTORY_ADD","INVENTORY MIDDLEWARE PASSED - INVENTORY DATA VALIDATED", ),
  addInvetoryItemService,
  log("INVENTORY_ADD", "INVENTORY SERVICE PASSED - OPERATION SUCCESSFUL"),
);

router.put("/update/:id",
  log("INVENTORY_UPDATE", "INVENTORY UPDATE ROUTE START"),
  sessionAuthMiddleware,
  log("INVENTORY_UPDATE", "SESSION MIDDLEWARE PASSED - USER AUTHENTICATED"),
  requirePermission("INVENTORY_UPDATE"),
  log("INVENTORY_UPDATE", "PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION"),
  updateInventoryMiddleware,
  log("INVENTORY_UPDATE", "INVENTORY MIDDLEWARE PASSED - UPDATE DATA VALIDATED"),
  updateInventoryItemService,
  log("INVENTORY_UPDATE", "INVENTORY SERVICE PASSED - OPERATION SUCCESSFUL")
);

export default router;
