const handlerKinds = Object.freeze({
    'transaction.completed': 'sale',
    transaction_completed: 'sale',
    process_sale: 'sale',
    sales: 'sale',
    'inventory.adjusted': 'inventory_adjustment',
    process_inventory_adjustment: 'inventory_adjustment',
    inventory_adjusted: 'inventory_adjustment',
});

export const resolveIntegrationHandlerKind = (handlerKey) => handlerKinds[handlerKey] ?? null;
