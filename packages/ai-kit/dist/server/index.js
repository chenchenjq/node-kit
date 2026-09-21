import { AiKitError, sanitizeError } from "./errors.js";
import { createManagement } from "./management.js";
import { createGeneration } from "./generation.js";
import { defaultLimits } from "./validation.js";
export function createAiKit(options) {
    if (!options?.scope ||
        options.scope.length > 100 ||
        !options.store ||
        !options.dictionary ||
        !options.secrets?.seal ||
        !options.secrets?.open)
        throw new AiKitError("CREDENTIAL_SECURITY_REQUIRED");
    if (!options.authorize || !options.rateLimit || !options.allowURL)
        throw new AiKitError("INVALID_CONFIG");
    for (const [key, value] of Object.entries({
        ...defaultLimits,
        ...options.limits,
    }))
        if (!Number.isSafeInteger(value) || value < (key === "maxRetries" ? 0 : 1))
            throw new AiKitError("INVALID_CONFIG");
    function safe(work) {
        return async (...args) => {
            try {
                return await work(...args);
            }
            catch (error) {
                throw sanitizeError(error);
            }
        };
    }
    const m = createManagement(options), g = createGeneration(m);
    return {
        listProviders: safe(m.listProviders),
        initializeDictionary: safe(m.initializeDictionary),
        listConnections: safe(m.listConnections),
        saveConnection: safe(m.saveConnection),
        deleteConnection: safe(m.deleteConnection),
        listPlans: safe(m.listPlans),
        savePlan: safe(m.savePlan),
        setDefault: safe(m.setDefault),
        listAuthorizedPlans: safe(m.listAuthorizedPlans),
        generate: safe(g.generate),
        stream: g.stream,
        testPlan: safe(g.testPlan),
        testDraft: safe(g.testDraft),
        refreshModels: safe(g.refreshModels),
    };
}
export { AiKitError } from "./errors.js";
export { createAesGcmSecretProtector, createEnvironmentSecretProtector, } from "./secrets.js";
