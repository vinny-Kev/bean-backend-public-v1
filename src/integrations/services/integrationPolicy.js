export const INVENTORY_SHORTAGE_POLICIES = Object.freeze([
    'require_intervention',
    'allow_negative_inventory',
    'record_sale_without_stock_deduction',
]);

export const resolveInventoryShortagePolicy = (value) => INVENTORY_SHORTAGE_POLICIES.includes(value)
    ? value : 'require_intervention';

export const getInventoryShortageBehavior = (value) => {
    const policy = resolveInventoryShortagePolicy(value);
    return {
        policy,
        deductStock: policy !== 'record_sale_without_stock_deduction',
        allowNegative: policy === 'allow_negative_inventory',
    };
};
