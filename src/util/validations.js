

export const compareToPattern = (value, pattern) => {
    switch (pattern) {
        case 'alphanumeric':
            return /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(value);
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        case 'password':
            return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])\S{8,}$/.test(value);
        case 'sku':
            return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value);
        default:
            return false;
    }

};

export const inRangeOfLength = (value, min, max) => {
    return value.length >= min && value.length <= max;
};