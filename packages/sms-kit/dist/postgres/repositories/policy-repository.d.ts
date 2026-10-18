import type { Pool } from "pg";
import type { BudgetReservation, HoldBudgetInput, PolicyStore, ReleaseBudgetInput, VerificationPolicy, VerificationPolicyUpdate } from "../../ports/policy.js";
import type { SmsTransaction } from "../../ports/store.js";
export declare class PgPolicyStore implements PolicyStore {
    private readonly pool;
    constructor(pool: Pool);
    get(tx?: SmsTransaction): Promise<VerificationPolicy>;
    update(input: VerificationPolicyUpdate, tx?: SmsTransaction): Promise<VerificationPolicy>;
    holdBudget(input: HoldBudgetInput, tx: SmsTransaction): Promise<BudgetReservation>;
    releaseBudget(input: ReleaseBudgetInput, tx: SmsTransaction): Promise<boolean>;
}
