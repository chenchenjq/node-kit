import {
  hasTemplateResourceSelection,
  type ResourceSyncCandidate,
  type ResourceSyncPreview,
  type SmsStore,
} from "../../../src/ports/store.js";

const fixtureNow = new Date("2026-09-14T00:00:00.000Z");
const fixtureExpiry = new Date("2030-01-01T00:00:00.000Z");

/** Seeds tests through the same explicit-import boundary exposed to hosts. */
export async function commitResourceFixturePreview(
  store: SmsStore,
  preview: ResourceSyncPreview,
  now = fixtureNow,
): Promise<void> {
  const syncCandidates = preview.candidates.filter((candidate) =>
    candidate.resourceType !== "template" || candidate.changeType !== "new");
  if (syncCandidates.length > 0) {
    await store.resources.commitSync({
      syncId: preview.id,
      candidates: syncCandidates.map(({ id, checksum }) => ({ id, checksum })),
      now,
    });
  }

  for (const candidate of preview.candidates) {
    if (candidate.resourceType !== "template" || candidate.changeType !== "new") continue;
    if (!hasTemplateResourceSelection(candidate)) {
      throw new Error("resource fixture new template is missing an explicit local selection");
    }
    const signatures = await store.resources.listSignatures({ page: 1, pageSize: 10_000 });
    const signature = signatures.items.find((item) => item.externalKey === candidate.signatureExternalKey);
    if (signature === undefined) throw new Error("resource fixture template signature is missing");
    await store.transaction((tx) => store.resources.importTemplate({
      candidateId: candidate.id,
      checksum: candidate.checksum,
      templateKey: candidate.templateKey,
      purpose: candidate.purpose,
      signatureExternalKey: candidate.signatureExternalKey,
      expectedSignatureVersion: signature.version,
      now,
    }, tx));
  }
}

export async function createResourceFixturePreview(
  store: SmsStore,
  resources: readonly ResourceSyncCandidate[],
  actorId = "fixture",
): Promise<ResourceSyncPreview> {
  const preview = await store.resources.createSyncPreview({
    id: crypto.randomUUID(),
    actorId,
    expiresAt: fixtureExpiry,
    resources,
  });
  await commitResourceFixturePreview(store, preview);
  return preview;
}
