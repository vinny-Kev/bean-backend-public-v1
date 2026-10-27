import { compareToPattern, inRangeOfLength, isPlainObject, parsePositiveId } from '../../util/validations.js';

const quantityIsValid = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const parseQuantity = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number.NaN;
};

export const inventoryMiddleware = (req, res, next) => {
    const body = req.body;
    if (!isPlainObject(body)) {
        return res.status(400).json({ message: 'A JSON object is required.' });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : '';
    const unit = body.unit === undefined ? 'unit' : body.unit;
    const quantity = body.quantity === undefined ? 0 : parseQuantity(body.quantity);

    if (!compareToPattern(name, 'alphanumeric') || !inRangeOfLength(name, 3, 50)) {
        return res.status(400).json({ message: 'Inventory name must be 3 to 50 alphanumeric characters.' });
    }
    if (!compareToPattern(sku, 'sku') || !inRangeOfLength(sku, 3, 20)) {
        return res.status(400).json({ message: 'SKU must be 3 to 20 characters using letters, numbers, and hyphens.' });
    }
    if (!quantityIsValid(quantity)) {
        return res.status(400).json({ message: 'Quantity must be a non-negative 32-bit integer.' });
    }
    if (typeof unit !== 'string' || !inRangeOfLength(unit.trim(), 1, 50)) {
        return res.status(400).json({ message: 'Unit must be 1 to 50 characters.' });
    }

    req.body = { name, sku, quantity, unit: unit.trim() };
    return next();
};

export const updateInventoryMiddleware = (req, res, next) => {
    const id = parsePositiveId(req.params.id);
    const body = req.body;
    if (!id) {
        return res.status(400).json({ message: 'Invalid inventory item ID.' });
    }
    if (!isPlainObject(body)) {
        return res.status(400).json({ message: 'A JSON object is required.' });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : '';
    const unit = typeof body.unit === 'string' ? body.unit.trim() : '';
    const quantity = parseQuantity(body.quantity);

    if (!compareToPattern(name, 'alphanumeric') || !inRangeOfLength(name, 3, 50)) {
        return res.status(400).json({ message: 'Inventory name must be 3 to 50 alphanumeric characters.' });
    }
    if (!compareToPattern(sku, 'sku') || !inRangeOfLength(sku, 3, 20)) {
        return res.status(400).json({ message: 'SKU must be 3 to 20 characters using letters, numbers, and hyphens.' });
    }
    if (!quantityIsValid(quantity)) {
        return res.status(400).json({ message: 'Quantity must be a non-negative 32-bit integer.' });
    }
    if (!inRangeOfLength(unit, 1, 50)) {
        return res.status(400).json({ message: 'Unit must be 1 to 50 characters.' });
    }

    // Existence is checked by the service inside the tenant-scoped transaction, so another
    // tenant's item IDs are indistinguishable from missing ones.
    req.params.id = id;
    req.body = { name, sku, quantity, unit };
    return next();
};
