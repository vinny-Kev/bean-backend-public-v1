import { test as nodeTest } from 'node:test';

export const integrationTest = (name, fn) => nodeTest(name, async (context) => {
    try {
        await fn(context);
        console.log(`[PASS] [INTEGRATION TESTS] ${name}\nexpected -> assertions pass\nactual -> assertions passed`);
    } catch (error) {
        console.error(`[FAIL] [INTEGRATION TESTS] ${name}\nexpected -> assertions pass\nactual -> ${error.name}: ${error.message}`);
        throw error;
    }
});

export const reportBlockedIntegrationCheck = (message, expected, actual) => {
    console.log(`[BLOCKED] [INTEGRATION TESTS] ${message}\nexpected -> ${expected}\nactual -> ${actual}`);
};
