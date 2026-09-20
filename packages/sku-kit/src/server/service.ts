import { buildCombinationKey, calculatePotentialCombinations, formatSkuCode, MAX_COMBINATIONS, MAX_DIMENSIONS, MAX_VALUES_PER_DIMENSION, normalizeSpecificationLabel, validateCnyAmount, validateRegisteredSpuCode } from "../core.js";
import type { Result, SkuProblem, SkuWarning } from "../types.js";
import type { AuthorizationResult, CombinationPairInput, ConfigurationPreview, ConsumerProjection, ConsumerSelectionDto, ConsumerSelectionInput, CopySkuConfigurationInput, HistoricalConfiguration, InventoryAuthority, InventoryDto, InventoryReadDto, ManagementConfiguration, PatchSkuConfigurationsInput, PersistedDimension, PersistedSku, PersistedValue, ProductDocument, SaveConfigurationInput, SetLocalInventoryInput, SkuAction, SkuConfigurationDto, SkuService, SkuStore, SpuRefInput } from "./contracts.js";

export interface CreateSkuServiceOptions<RequestContext> {
  store: SkuStore;
  resolveScope(context: RequestContext): Promise<string>;
  authorize(context: RequestContext, action: SkuAction, resource: { spuId: string }): Promise<AuthorizationResult>;
  projectConsumer?(skus: readonly PersistedSku[]): Promise<readonly ConsumerProjection[]>;
  resolveInventoryAuthority?(context: RequestContext, scopeKey: string): Promise<InventoryAuthority>;
  approveModeChange?(context: RequestContext, change: { spuId: string; from: "default" | "multi"; to: "default" | "multi"; document: ProductDocument }): Promise<Result<true>>;
  readExternalInventory?(context: RequestContext, request: { scopeKey: string; spuId: string; skuId: string; authority: InventoryAuthority }): Promise<Result<InventoryReadDto>>;
  setExternalInventory?(context: RequestContext, request: SetLocalInventoryInput & { scopeKey: string; authority: InventoryAuthority }): Promise<Result<InventoryDto>>;
  createId?: () => string;
}

const problem = (code: SkuProblem["code"], message: string, retryable = false): SkuProblem => ({ code, message, retryable });
const fail = <T>(code: SkuProblem["code"], message: string): Result<T> => ({ ok: false, problem: problem(code, message) });
const fingerprint = (value: unknown): string => JSON.stringify(value);
const validCommandId = (commandId: string): boolean => commandId.trim().length > 0 && commandId.length <= 128;
const compareDecimal = (left: string, right: string): number => {
  const [leftInteger = "", leftFraction = ""] = left.split(".");
  const [rightInteger = "", rightFraction = ""] = right.split(".");
  const integer = (leftInteger.length - rightInteger.length) || leftInteger.localeCompare(rightInteger);
  return integer || leftFraction.padEnd(18, "0").localeCompare(rightFraction.padEnd(18, "0"));
};
const priceWarnings = (skus: readonly { supplyPrice: string | null; suggestedRetailPrice: string | null }[]): readonly SkuWarning[] =>
  skus.some((sku) => sku.supplyPrice !== null && sku.suggestedRetailPrice !== null && compareDecimal(sku.supplyPrice, sku.suggestedRetailPrice) > 0)
    ? [{ code: "SUPPLY_PRICE_ABOVE_RETAIL", message: "供应价高于建议零售价" }] : [];

const clone = <T>(value: T): T => structuredClone(value);

const createDocument = (scopeKey: string, input: SaveConfigurationInput): ProductDocument => ({
  scopeKey,
  spuId: input.spuId,
  registeredSpuCode: input.spuCode,
  structureVersion: 0n,
  nextSequence: 0,
  dimensions: [],
  skus: [],
  inventories: {},
  commands: [],
});

const validateStructure = (input: SaveConfigurationInput): SkuProblem | null => {
  if (input.dimensions.length > MAX_DIMENSIONS) return problem("VALIDATION_FAILED", "销售规格维度不能超过五个");
  const dimensions = new Set<string>();
  for (const dimension of input.dimensions) {
    const normalizedDimension = normalizeSpecificationLabel(dimension.label);
    if (!normalizedDimension || dimensions.has(normalizedDimension)) return problem("VALIDATION_FAILED", "销售规格维度名称重复或为空");
    dimensions.add(normalizedDimension);
    if (dimension.values.length === 0 || dimension.values.length > MAX_VALUES_PER_DIMENSION) return problem("VALIDATION_FAILED", "每个维度必须有一到一百个规格值");
    const values = new Set<string>();
    for (const value of dimension.values) {
      const normalizedValue = normalizeSpecificationLabel(value.label);
      if (!normalizedValue || values.has(normalizedValue)) return problem("VALIDATION_FAILED", "同一维度的规格值重复或为空");
      values.add(normalizedValue);
    }
  }
  if (!calculatePotentialCombinations(input.dimensions.map((dimension) => dimension.values.length)).ok) return problem("VALIDATION_FAILED", "规格值的潜在组合不能超过一百个");
  if (input.selectedCombinations.length > MAX_COMBINATIONS) return problem("VALIDATION_FAILED", "实际销售组合不能超过一百个");
  if (input.dimensions.length === 0 && input.selectedCombinations.length !== 0) return problem("VALIDATION_FAILED", "无规格商品不能提交自定义组合");
  if (input.dimensions.length > 0 && input.selectedCombinations.length === 0) return problem("VALIDATION_FAILED", "多规格商品至少需要一个销售组合");
  return null;
};

const resolvePairs = (pairs: readonly CombinationPairInput[], mappings: Readonly<Record<string, string>>, dimensions: readonly PersistedDimension[]): Result<{ dimensionId: string; valueId: string }[]> => {
  const resolved = pairs.map((pair) => ({
    dimensionId: pair.dimensionId ?? (pair.dimensionDraftKey === undefined ? undefined : mappings[pair.dimensionDraftKey]),
    valueId: pair.valueId ?? (pair.valueDraftKey === undefined ? undefined : mappings[pair.valueDraftKey]),
  }));
  if (resolved.some((pair) => pair.dimensionId === undefined || pair.valueId === undefined)) return fail("VALIDATION_FAILED", "组合必须引用已知维度和值");
  if (resolved.length !== dimensions.length) return fail("VALIDATION_FAILED", "组合必须为每个销售规格维度选择一个值");
  const checked = resolved as { dimensionId: string; valueId: string }[];
  const usedDimensions = new Set<string>();
  for (const pair of checked) {
    const dimension = dimensions.find((candidate) => candidate.id === pair.dimensionId);
    if (dimension === undefined || usedDimensions.has(pair.dimensionId) || !dimension.values.some((value) => value.id === pair.valueId)) {
      return fail("VALIDATION_FAILED", "组合包含不属于当前商品的规格值");
    }
    usedDimensions.add(pair.dimensionId);
  }
  return { ok: true, value: checked };
};

export const createSkuService = <RequestContext>(options: CreateSkuServiceOptions<RequestContext>): SkuService<RequestContext> => {
  const createId = options.createId ?? (() => crypto.randomUUID());

  const scopeFor = async (context: RequestContext): Promise<string | null> => {
    const scope = await options.resolveScope(context);
    return scope.trim() === "" ? null : scope;
  };

  const allowed = async (context: RequestContext, action: SkuAction, spuId: string): Promise<Result<true>> => {
    const authorization = await options.authorize(context, action, { spuId });
    return authorization.ok ? { ok: true, value: true } : { ok: false, problem: authorization.problem ?? problem("FORBIDDEN", "没有执行该操作的权限") };
  };
  const inventoryAuthorityFor = async (context: RequestContext, scopeKey: string, bind = true): Promise<Result<InventoryAuthority>> => {
    const authority = await (options.resolveInventoryAuthority?.(context, scopeKey) ?? Promise.resolve({ kind: "local-read-write" as const, authorityKey: "sku-kit-local" }));
    if (authority.authorityKey.trim() === "") return fail("VALIDATION_FAILED", "库存权威键不能为空");
    return !bind || options.store.ensureInventoryAuthority === undefined ? { ok: true, value: authority } : options.store.ensureInventoryAuthority(scopeKey, authority);
  };

  const preview = (existing: ProductDocument | null, input: Omit<SaveConfigurationInput, "commandId" | "expectedStructureVersion" | "restoreArchivedSkuIds">): Result<ConfigurationPreview> => {
    const mappings: Record<string, string> = {};
    const dimensions: PersistedDimension[] = input.dimensions.map((dimension) => {
      const old = dimension.id === undefined ? undefined : existing?.dimensions.find((candidate) => candidate.id === dimension.id);
      const id = old?.id ?? dimension.id ?? `draft:${dimension.draftKey ?? dimension.label}`;
      if (dimension.draftKey !== undefined) mappings[dimension.draftKey] = id;
      return { id, label: dimension.label, normalizedLabel: normalizeSpecificationLabel(dimension.label), sort: dimension.sort, archived: false, values: dimension.values.map((value) => {
        const oldValue = value.id === undefined ? undefined : old?.values.find((candidate) => candidate.id === value.id);
        const valueId = oldValue?.id ?? value.id ?? `draft:${value.draftKey ?? value.label}`;
        if (value.draftKey !== undefined) mappings[value.draftKey] = valueId;
        return { id: valueId, label: value.label, normalizedLabel: normalizeSpecificationLabel(value.label), sort: value.sort, archived: false };
      }) };
    });
    const proposed = input.dimensions.length === 0 ? [{ pairs: [] }] : input.selectedCombinations;
    const combinations: Array<ConfigurationPreview["combinations"][number]> = [];
    const keys = new Set<string>();
    for (const candidate of proposed) {
      const pairs = resolvePairs(candidate.pairs, mappings, dimensions);
      if (!pairs.ok) return pairs;
      const key = buildCombinationKey(pairs.value);
      if (keys.has(key)) return fail("COMBINATION_CONFLICT", "同一 SPU 不允许重复规格组合");
      keys.add(key);
      const current = existing?.skus.find((sku) => sku.combinationKey === key);
      combinations.push(current === undefined ? { combinationKey: key, kind: "added" } : { combinationKey: key, kind: current.archived ? "restorable" : "retained", skuId: current.id, skuCode: current.skuCode });
    }
    for (const sku of existing?.skus ?? []) if (!sku.archived && !keys.has(sku.combinationKey)) combinations.push({ combinationKey: sku.combinationKey, kind: "archivable", skuId: sku.id, skuCode: sku.skuCode });
    const oldIsDefault = existing?.skus.some((sku) => !sku.archived && sku.pairs.length === 0) ?? false;
    return { ok: true, value: { combinations, changesMode: oldIsDefault !== (input.dimensions.length === 0) } };
  };

  return {
    async previewConfiguration(context, input) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<ConfigurationPreview>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "structure.write", input.spuId);
      if (!authorization.ok) return authorization;
      const code = validateRegisteredSpuCode(input.spuCode);
      if (!code.ok) return code;
      const invalid = validateStructure({ ...input, commandId: "preview" });
      if (invalid !== null) return { ok: false, problem: invalid };
      const existing = await options.store.read(scopeKey, input.spuId);
      if (existing !== null && existing.registeredSpuCode !== input.spuCode) return fail("SPU_CODE_MISMATCH", "SPU 编码已冻结，不能修改");
      return preview(existing, input);
    },
    async saveConfiguration(context, input) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "structure.write", input.spuId);
      if (!authorization.ok) return authorization;
      if (!validCommandId(input.commandId)) return fail("VALIDATION_FAILED", "commandId 必须是 1 至 128 个非空白字符");
      const inventoryAuthority = await inventoryAuthorityFor(context, scopeKey);
      if (!inventoryAuthority.ok) return inventoryAuthority;
      const code = validateRegisteredSpuCode(input.spuCode);
      if (!code.ok) return code;
      const existingCode = await options.store.findByRegisteredSpuCode?.(scopeKey, code.value);
      if (existingCode !== undefined && existingCode !== null && existingCode.spuId !== input.spuId) return fail("SPU_CODE_CONFLICT", "同一作用域内 SPU 编码必须唯一");
      const invalid = validateStructure(input);
      if (invalid !== null) return { ok: false, problem: invalid };
      const requestFingerprint = fingerprint(input);

      return options.store.transact(scopeKey, input.spuId, async (existing) => {
        const document = existing === null ? createDocument(scopeKey, input) : clone(existing);
        if (document.registeredSpuCode !== input.spuCode) return { document, result: fail("SPU_CODE_MISMATCH", "SPU 编码已冻结，不能修改") };
        const receipt = document.commands.find((candidate) => candidate.commandId === input.commandId);
        if (receipt !== undefined) {
          return {
            document,
            result: receipt.fingerprint === requestFingerprint
              ? { ok: true, value: clone(receipt.result) as import("./contracts.js").SavedConfiguration }
              : fail("IDEMPOTENCY_CONFLICT", "相同 commandId 使用了不同载荷"),
          };
        }
        if (input.expectedStructureVersion !== undefined && input.expectedStructureVersion !== document.structureVersion.toString()) {
          return { document, result: fail("VERSION_CONFLICT", "规格结构已被其他编辑修改") };
        }
        for (const dimension of input.dimensions) {
          const previous = dimension.id === undefined ? undefined : document.dimensions.find((candidate) => candidate.id === dimension.id);
          if (dimension.id !== undefined && previous === undefined) return { document, result: fail("VALIDATION_FAILED", "新规格维度必须使用 draftKey") };
          if (previous !== undefined && dimension.values.some((value) => value.id !== undefined && !previous.values.some((candidate) => candidate.id === value.id))) return { document, result: fail("VALIDATION_FAILED", "新规格值必须使用 draftKey") };
        }
        const from = document.skus.some((sku) => !sku.archived && sku.pairs.length === 0) ? "default" : "multi";
        const to = input.dimensions.length === 0 ? "default" : "multi";
        if (existing !== null && from !== to) {
          const approval = options.approveModeChange === undefined
            ? Object.values(document.inventories).some((inventory) => inventory.quantity !== 0)
              ? fail<true>("TRANSITION_BLOCKED", "模式转换前必须由宿主处理非零库存")
              : { ok: true as const, value: true }
            : await options.approveModeChange(context, { spuId: input.spuId, from, to, document: clone(document) });
          if (!approval.ok) return { document, result: approval };
        }
        const mappings: Record<string, string> = {};
        const dimensions: PersistedDimension[] = input.dimensions.map((dimension) => {
          const previous = dimension.id === undefined ? undefined : document.dimensions.find((candidate) => candidate.id === dimension.id);
          const dimensionId = previous?.id ?? dimension.id ?? createId();
          if (dimension.draftKey !== undefined) mappings[dimension.draftKey] = dimensionId;
          const values: PersistedValue[] = dimension.values.map((value) => {
            const oldValue = value.id === undefined ? undefined : previous?.values.find((candidate) => candidate.id === value.id);
            const valueId = oldValue?.id ?? value.id ?? createId();
            if (value.draftKey !== undefined) mappings[value.draftKey] = valueId;
            return { id: valueId, label: value.label, normalizedLabel: normalizeSpecificationLabel(value.label), sort: value.sort, archived: false };
          });
          if (previous !== undefined) {
            for (const oldValue of previous.values) if (!values.some((value) => value.id === oldValue.id)) values.push({ ...oldValue, archived: true });
          }
          return { id: dimensionId, label: dimension.label, normalizedLabel: normalizeSpecificationLabel(dimension.label), sort: dimension.sort, values, archived: false };
        });
        for (const oldDimension of document.dimensions) if (!dimensions.some((dimension) => dimension.id === oldDimension.id)) dimensions.push({ ...oldDimension, archived: true, values: oldDimension.values.map((value) => ({ ...value, archived: true })) });
        const combinations = input.dimensions.length === 0 ? [{ pairs: [] }] : input.selectedCombinations;
        const seen = new Set<string>();
        const skus: PersistedSku[] = [];
        for (const combination of combinations) {
          const resolvedPairs = resolvePairs(combination.pairs, mappings, dimensions);
          if (!resolvedPairs.ok) return { document, result: resolvedPairs };
          const key = buildCombinationKey(resolvedPairs.value);
          if (seen.has(key)) return { document, result: fail("COMBINATION_CONFLICT", "同一 SPU 不允许重复规格组合") };
          seen.add(key);
          const oldSku = document.skus.find((sku) => sku.combinationKey === key);
          if (oldSku !== undefined && !oldSku.archived) {
            skus.push({ ...oldSku, pairs: resolvedPairs.value });
            continue;
          }
          if (oldSku !== undefined && oldSku.archived) {
            if (!(input.restoreArchivedSkuIds ?? []).includes(oldSku.id)) return { document, result: fail("RESTORE_REQUIRED", "恢复历史组合必须显式指定原 SKU") };
            skus.push({ ...oldSku, pairs: resolvedPairs.value, archived: false, status: "disabled", configVersion: oldSku.configVersion + 1n });
            continue;
          }
          if (document.nextSequence >= 100) return { document, result: fail("CAPACITY_EXHAUSTED", "SKU 编码容量已耗尽") };
          const formatted = formatSkuCode(document.registeredSpuCode, document.nextSequence);
          if (!formatted.ok) return { document, result: formatted };
          const skuId = createId();
          skus.push({ id: skuId, skuCode: formatted.value, sequence: document.nextSequence, combinationKey: key, pairs: resolvedPairs.value, status: "disabled", suggestedRetailPrice: null, supplyPrice: null, image: null, configVersion: 1n, archived: false });
          document.inventories[skuId] = { quantity: 0, version: 1n };
          document.nextSequence += 1;
        }
        for (const oldSku of document.skus) {
          if (!oldSku.archived && !skus.some((sku) => sku.id === oldSku.id)) skus.push({ ...oldSku, archived: true, status: "archived", configVersion: oldSku.configVersion + 1n });
        }
        document.dimensions = dimensions;
        document.skus = skus;
        document.structureVersion += 1n;
        const saved = { structureVersion: document.structureVersion.toString(), skus: skus.filter((sku) => !sku.archived).map(({ id, skuCode, combinationKey, status }) => ({ skuId: id, skuCode, combinationKey, status })), draftKeyMappings: mappings };
        document.commands.push({ commandId: input.commandId, fingerprint: requestFingerprint, result: clone(saved) });
        return { document, result: { ok: true, value: saved } };
      });
    },

    async patchSkuConfigurations(context, input: PatchSkuConfigurationsInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<readonly SkuConfigurationDto[]>("SCOPE_MISMATCH", "可信作用域不能为空");
      const configurationAuthorization = await allowed(context, "configuration.write", input.spuId);
      if (!configurationAuthorization.ok) return configurationAuthorization;
      if (!validCommandId(input.commandId)) return fail("VALIDATION_FAILED", "commandId 必须是 1 至 128 个非空白字符");
      const inventoryAuthority = await inventoryAuthorityFor(context, scopeKey);
      if (!inventoryAuthority.ok) return inventoryAuthority;
      if (input.patches.some((patch) => patch.supplyPrice !== undefined)) {
        const supplyAuthorization = await allowed(context, "supply-price.write", input.spuId);
        if (!supplyAuthorization.ok) return supplyAuthorization;
      }
      if (input.patches.length === 0) return fail("VALIDATION_FAILED", "至少需要一个 SKU 配置补丁");
      const requestFingerprint = fingerprint(input);
      return options.store.transact(scopeKey, input.spuId, (existing) => {
        if (existing === null) return { result: fail<readonly SkuConfigurationDto[]>("NOT_FOUND", "未找到 SKU 配置") };
        const document = clone(existing);
        const receipt = document.commands.find((candidate) => candidate.commandId === input.commandId);
        if (receipt !== undefined) {
          const replay = clone(receipt.result) as readonly SkuConfigurationDto[];
          return { document, result: receipt.fingerprint === requestFingerprint
            ? { ok: true, value: replay, ...(priceWarnings(replay).length === 0 ? {} : { warnings: priceWarnings(replay) }) }
            : fail<readonly SkuConfigurationDto[]>("IDEMPOTENCY_CONFLICT", "相同 commandId 使用了不同载荷") };
        }
        if (input.expectedStructureVersion !== undefined && input.expectedStructureVersion !== document.structureVersion.toString()) return { document, result: fail<readonly SkuConfigurationDto[]>("VERSION_CONFLICT", "规格结构已被其他编辑修改") };
        const affected: SkuConfigurationDto[] = [];
        const ids = new Set<string>();
        for (const patch of input.patches) {
          if (ids.has(patch.skuId)) return { document, result: fail<readonly SkuConfigurationDto[]>("VALIDATION_FAILED", "同一 SKU 只能出现一次") };
          ids.add(patch.skuId);
          const sku = document.skus.find((candidate) => candidate.id === patch.skuId);
          if (sku === undefined || sku.archived) return { document, result: fail<readonly SkuConfigurationDto[]>("NOT_FOUND", "未找到可配置 SKU") };
          if (sku.configVersion.toString() !== patch.expectedConfigVersion) return { document, result: fail<readonly SkuConfigurationDto[]>("VERSION_CONFLICT", "SKU 配置已被其他编辑修改") };
          if (patch.suggestedRetailPrice !== undefined && patch.suggestedRetailPrice !== null) {
            const price = validateCnyAmount(patch.suggestedRetailPrice);
            if (!price.ok) return { document, result: price };
            sku.suggestedRetailPrice = price.value;
          } else if (patch.suggestedRetailPrice === null) sku.suggestedRetailPrice = null;
          if (patch.supplyPrice !== undefined && patch.supplyPrice !== null) {
            const price = validateCnyAmount(patch.supplyPrice);
            if (!price.ok) return { document, result: price };
            sku.supplyPrice = price.value;
          } else if (patch.supplyPrice === null) sku.supplyPrice = null;
          if (patch.image !== undefined) sku.image = patch.image;
          if (patch.status !== undefined) sku.status = patch.status;
          sku.configVersion += 1n;
          affected.push({ currency: "CNY", skuId: sku.id, skuCode: sku.skuCode, status: sku.status, suggestedRetailPrice: sku.suggestedRetailPrice, supplyPrice: sku.supplyPrice, image: sku.image, configVersion: sku.configVersion.toString() });
        }
        document.commands.push({ commandId: input.commandId, fingerprint: requestFingerprint, result: clone(affected) });
        const warnings = priceWarnings(affected);
        return { document, result: { ok: true, value: affected, ...(warnings.length === 0 ? {} : { warnings }) } };
      });
    },

    async copySkuConfiguration(context, input: CopySkuConfigurationInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<readonly SkuConfigurationDto[]>("SCOPE_MISMATCH", "可信作用域不能为空");
      const configuration = await allowed(context, "configuration.write", input.spuId);
      if (!configuration.ok) return configuration;
      if (!validCommandId(input.commandId)) return fail("VALIDATION_FAILED", "commandId 必须是 1 至 128 个非空白字符");
      if (input.fields.includes("supplyPrice")) { const supply = await allowed(context, "supply-price.write", input.spuId); if (!supply.ok) return supply; }
      if (input.fields.length === 0 || input.targetSkuIds.length === 0 || new Set(input.targetSkuIds).size !== input.targetSkuIds.length) return fail("VALIDATION_FAILED", "复制必须指定不重复的字段和目标 SKU");
      const authority = await inventoryAuthorityFor(context, scopeKey); if (!authority.ok) return authority;
      const requestFingerprint = fingerprint(input);
      return options.store.transact(scopeKey, input.spuId, (existing) => {
        if (existing === null) return { result: fail<readonly SkuConfigurationDto[]>("NOT_FOUND", "未找到 SKU 配置") };
        const document = clone(existing); const receipt = document.commands.find((item) => item.commandId === input.commandId);
        if (receipt !== undefined) return { document, result: receipt.fingerprint === requestFingerprint ? { ok: true, value: clone(receipt.result) as readonly SkuConfigurationDto[] } : fail<readonly SkuConfigurationDto[]>("IDEMPOTENCY_CONFLICT", "相同 commandId 使用了不同载荷") };
        const source = document.skus.find((sku) => sku.id === input.sourceSkuId && !sku.archived);
        if (source === undefined) return { document, result: fail<readonly SkuConfigurationDto[]>("NOT_FOUND", "未找到来源 SKU") };
        const targets = input.targetSkuIds.map((id) => document.skus.find((sku) => sku.id === id && !sku.archived));
        if (targets.some((target) => target === undefined) || input.targetSkuIds.includes(source.id)) return { document, result: fail<readonly SkuConfigurationDto[]>("VALIDATION_FAILED", "复制目标必须是其他有效 SKU") };
        const copied: SkuConfigurationDto[] = [];
        for (const target of targets as PersistedSku[]) {
          for (const field of input.fields) {
            if (field === "suggestedRetailPrice" && (input.mode === "overwrite" || target.suggestedRetailPrice === null)) target.suggestedRetailPrice = source.suggestedRetailPrice;
            if (field === "supplyPrice" && (input.mode === "overwrite" || target.supplyPrice === null)) target.supplyPrice = source.supplyPrice;
            if (field === "image" && (input.mode === "overwrite" || target.image === null)) target.image = source.image;
          }
          target.configVersion += 1n;
          copied.push({ currency: "CNY", skuId: target.id, skuCode: target.skuCode, status: target.status, suggestedRetailPrice: target.suggestedRetailPrice, supplyPrice: target.supplyPrice, image: target.image, configVersion: target.configVersion.toString() });
        }
        document.commands.push({ commandId: input.commandId, fingerprint: requestFingerprint, result: clone(copied) });
        return { document, result: { ok: true, value: copied } };
      });
    },

    async getManagementConfiguration(context, input: SpuRefInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<ManagementConfiguration>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "management.read", input.spuId);
      if (!authorization.ok) return authorization;
      const document = await options.store.read(scopeKey, input.spuId);
      if (document === null) return fail("NOT_FOUND", "未找到 SKU 配置");
      const supply = await allowed(context, "supply-price.read", input.spuId);
      const skus = supply.ok ? clone(document.skus) : document.skus.map(({ supplyPrice: _supplyPrice, ...sku }) => clone(sku));
      return { ok: true, value: { currency: "CNY", spuId: document.spuId, registeredSpuCode: document.registeredSpuCode, structureVersion: document.structureVersion.toString(), dimensions: clone(document.dimensions), skus } };
    },

    async getHistoricalConfiguration(context, input: SpuRefInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<HistoricalConfiguration>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "history.read", input.spuId);
      if (!authorization.ok) return authorization;
      const document = await options.store.read(scopeKey, input.spuId);
      if (document === null) return fail("NOT_FOUND", "未找到 SKU 配置");
      const supply = await allowed(context, "supply-price.read", input.spuId);
      const archivedSkus = supply.ok ? clone(document.skus.filter((sku) => sku.archived)) : document.skus.filter((sku) => sku.archived).map(({ supplyPrice: _supplyPrice, ...sku }) => clone({ ...sku, supplyPrice: null }));
      return { ok: true, value: { currency: "CNY", spuId: document.spuId, registeredSpuCode: document.registeredSpuCode, archivedSkus } };
    },

    async getConsumerSelection(context, input: ConsumerSelectionInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<ConsumerSelectionDto>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "consumer.read", input.spuId);
      if (!authorization.ok) return authorization;
      const document = await options.store.read(scopeKey, input.spuId);
      if (document === null) return fail("NOT_FOUND", "未找到 SKU 配置");
      const valueOwners = new Map<string, string>();
      for (const dimension of document.dimensions) if (!dimension.archived) for (const value of dimension.values) if (!value.archived) valueOwners.set(value.id, dimension.id);
      const chosenDimensions = new Set<string>();
      for (const valueId of input.selectedValueIds) {
        const dimensionId = valueOwners.get(valueId);
        if (dimensionId === undefined || chosenDimensions.has(dimensionId)) return fail<ConsumerSelectionDto>("VALIDATION_FAILED", "每个规格维度只能选择一个有效规格值");
        chosenDimensions.add(dimensionId);
      }
      const active = document.skus.filter((sku) => !sku.archived && sku.status === "enabled");
      const projections = new Map((await (options.projectConsumer?.(active) ?? Promise.resolve(active.map((sku) => ({ skuId: sku.id, visible: true, selectable: true, salePrice: null, availability: "unknown" }))))).map((entry) => [entry.skuId, entry]));
      const visible = active.filter((sku) => projections.get(sku.id)?.visible === true);
      const selected = new Set(input.selectedValueIds);
      const candidates = visible.filter((sku) => sku.pairs.filter((pair) => selected.has(pair.valueId)).length === selected.size);
      const exact = candidates.filter((sku) => sku.pairs.length === selected.size && projections.get(sku.id)?.selectable === true);
      const priceCandidates = selected.size === 0 ? visible : candidates;
      const known = priceCandidates.map((sku) => projections.get(sku.id)?.salePrice).filter((price): price is string => price !== null && price !== undefined).sort(compareDecimal);
      const range = known.length === 0 ? { status: "unknown" as const, min: null, max: null } : { status: known.length === priceCandidates.length ? "complete" as const : "partial" as const, min: known[0] ?? null, max: known.at(-1) ?? null };
      const dimensions = document.dimensions.filter((dimension) => !dimension.archived).map((dimension) => ({ dimensionId: dimension.id, label: dimension.label, options: dimension.values.filter((value) => !value.archived).map((value) => {
        const valueCandidates = candidates.filter((sku) => sku.pairs.some((pair) => pair.valueId === value.id));
        const projection = valueCandidates.map((sku) => projections.get(sku.id)).find((entry) => entry?.selectable === true);
        const selectedHere = selected.has(value.id);
        return { valueId: value.id, label: value.label, state: selectedHere ? "selected" as const : projection !== undefined ? "selectable" as const : valueCandidates.some((sku) => projections.get(sku.id)?.availability === "out-of-stock") ? "out-of-stock" as const : valueCandidates.length === 0 ? "impossible" as const : "unavailable" as const };
      }) }));
      const resolved = exact.length === 1 ? exact[0] : undefined;
      const selectedProjection = resolved === undefined ? undefined : projections.get(resolved.id);
      return { ok: true, value: { currency: "CNY", dimensions, selectedSku: resolved === undefined || selectedProjection === undefined ? null : { skuId: resolved.id, skuCode: resolved.skuCode, salePrice: selectedProjection.salePrice, availability: selectedProjection.availability }, image: resolved?.image ?? input.spuImage ?? null, priceRange: range } };
    },

    async getInventory(context, input) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<InventoryReadDto>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "inventory.read", input.spuId);
      if (!authorization.ok) return authorization;
      const authority = await inventoryAuthorityFor(context, scopeKey, false);
      if (!authority.ok) return authority;
      const document = await options.store.read(scopeKey, input.spuId);
      if (document === null || !document.skus.some((sku) => sku.id === input.skuId && !sku.archived)) return fail("NOT_FOUND", "未找到可读取的 SKU 库存");
      if (authority.value.kind !== "local-read-write") {
        return options.readExternalInventory === undefined
          ? { ok: true, value: { state: "unknown", skuId: input.skuId, reason: "外部库存适配器不可用" } }
          : options.readExternalInventory(context, { scopeKey, spuId: input.spuId, skuId: input.skuId, authority: authority.value });
      }
      const inventory = document?.inventories[input.skuId];
      if (document === null || inventory === undefined || !document.skus.some((sku) => sku.id === input.skuId && !sku.archived)) return fail("NOT_FOUND", "未找到可读取的 SKU 库存");
      return { ok: true, value: { state: "known", skuId: input.skuId, quantity: inventory.quantity, inventoryVersion: inventory.version.toString() } };
    },

    async setLocalInventory(context, input: SetLocalInventoryInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<InventoryDto>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "inventory.write", input.spuId);
      if (!authorization.ok) return authorization;
      if (!validCommandId(input.commandId)) return fail("VALIDATION_FAILED", "commandId 必须是 1 至 128 个非空白字符");
      const resolvedAuthority = await inventoryAuthorityFor(context, scopeKey);
      if (!resolvedAuthority.ok) return resolvedAuthority;
      const authority = resolvedAuthority.value;
      if (authority.kind !== "local-read-write") return fail<InventoryDto>(authority.kind === "external-read-only" ? "INVENTORY_READ_ONLY" : "ADAPTER_FAILURE", "当前作用域不由本地库存权威管理");
      if (!Number.isInteger(input.quantity) || input.quantity < 0) return fail("VALIDATION_FAILED", "库存必须是非负整数");
      const requestFingerprint = fingerprint(input);
      return options.store.transact(scopeKey, input.spuId, (existing) => {
        if (existing === null) return { result: fail<InventoryDto>("NOT_FOUND", "未找到 SKU 配置") };
        const document = clone(existing);
        const receipt = document.commands.find((candidate) => candidate.commandId === input.commandId);
        if (receipt !== undefined) return { document, result: receipt.fingerprint === requestFingerprint ? { ok: true, value: clone(receipt.result) as InventoryDto } : fail<InventoryDto>("IDEMPOTENCY_CONFLICT", "相同 commandId 使用了不同载荷") };
        const sku = document.skus.find((candidate) => candidate.id === input.skuId && !candidate.archived);
        const inventory = document.inventories[input.skuId];
        if (sku === undefined || inventory === undefined) return { document, result: fail<InventoryDto>("NOT_FOUND", "未找到可配置 SKU 库存") };
        if (inventory.version.toString() !== input.expectedInventoryVersion) return { document, result: fail<InventoryDto>("VERSION_CONFLICT", "库存已被其他编辑修改") };
        inventory.quantity = input.quantity;
        inventory.version += 1n;
        const result = { skuId: input.skuId, quantity: inventory.quantity, inventoryVersion: inventory.version.toString() };
        document.commands.push({ commandId: input.commandId, fingerprint: requestFingerprint, result: clone(result) });
        return { document, result: { ok: true, value: result } };
      });
    },

    async setExternalInventory(context, input: SetLocalInventoryInput) {
      const scopeKey = await scopeFor(context);
      if (scopeKey === null) return fail<InventoryDto>("SCOPE_MISMATCH", "可信作用域不能为空");
      const authorization = await allowed(context, "inventory.write", input.spuId);
      if (!authorization.ok) return authorization;
      if (!validCommandId(input.commandId)) return fail("VALIDATION_FAILED", "commandId 必须是 1 至 128 个非空白字符");
      if (!Number.isInteger(input.quantity) || input.quantity < 0) return fail("VALIDATION_FAILED", "库存必须是非负整数");
      const resolved = await inventoryAuthorityFor(context, scopeKey);
      if (!resolved.ok) return resolved;
      if (resolved.value.kind === "external-read-only") return fail("INVENTORY_READ_ONLY", "外部库存权威为只读");
      if (resolved.value.kind !== "external-read-write") return fail("VALIDATION_FAILED", "当前作用域不由外部库存权威管理");
      if (options.setExternalInventory === undefined) return fail("ADAPTER_FAILURE", "外部库存写入适配器不可用");
      return options.setExternalInventory(context, { ...input, scopeKey, authority: resolved.value });
    },
  };
};
