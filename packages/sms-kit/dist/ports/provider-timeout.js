import { SmsKitError } from "../core/errors.js";
import { positiveTimeoutMs } from "./provider.js";
/** Only the winner can reach persistence; an eventual transport response has no continuation. */
export async function withProviderTimeout(operation, timeoutMs) {
    positiveTimeoutMs(timeoutMs);
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => operation(controller.signal)),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new SmsKitError("ACCEPTANCE_UNKNOWN", "provider request deadline exceeded");
                    controller.abort(error);
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
