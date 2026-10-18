export function positiveTimeoutMs(value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError("provider timeout must be positive");
    }
    return value;
}
