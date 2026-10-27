-- The registered payload schemas for the two supported handlers drifted from
-- the contract the worker implements (snake_case `transaction_id`/`product_id`
-- vs. the camelCase fields validated in integrationOriginMiddleware.js), so no
-- event could satisfy both and every delivery was rejected. Align the registry
-- with the handler contract documented in src/integrations/README.md.
-- Existing handler_key, description, and is_active values are preserved.
INSERT INTO event_registry (event_type, description, handler_key, payload_schema)
VALUES
    ('transaction.completed',
     'A storefront transaction has been completed successfully.',
     'transaction_completed',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "additionalProperties": false,
        "required": ["externalTransactionId", "productId", "quantity", "status", "saleAmount", "currency", "externalUserId"],
        "properties": {
            "externalTransactionId": { "type": "string", "minLength": 1, "maxLength": 255 },
            "productId": { "type": "string", "pattern": "^[A-Za-z0-9-]{1,100}$" },
            "quantity": { "type": "integer", "minimum": 1, "maximum": 2147483647 },
            "status": { "const": "completed" },
            "saleAmount": { "type": "string", "pattern": "^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?$" },
            "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
            "externalUserId": { "type": "string", "minLength": 1, "maxLength": 255 }
        }
     }'::jsonb),
    ('inventory.adjusted',
     'Inventory stock has been adjusted by the source application.',
     'inventory_adjusted',
     '{
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "additionalProperties": false,
        "required": ["productId", "quantity", "adjustment"],
        "properties": {
            "productId": { "type": "string", "pattern": "^[A-Za-z0-9-]{1,100}$" },
            "quantity": { "type": "integer", "minimum": 1, "maximum": 2147483647 },
            "adjustment": { "enum": ["increase", "decrease", "set"] }
        }
     }'::jsonb)
ON CONFLICT (event_type) DO UPDATE
    SET payload_schema = EXCLUDED.payload_schema, updated_at = NOW();
