import { OperationLocalGovernment, OperationState } from '@models/platform/geography.model';
import { nextPublicIds } from '@modules/platform/public-id.service';
import {
  capitalForState,
  loadNigerianLocationCatalog,
  normalizeLgaName,
  stateCatalogKey,
} from '@lib/nigeria-location-catalog';
import { NIGERIAN_STATES } from '@lib/nigeria-states';

function normalizedName(value: string) {
  return normalizeLgaName(value).toLocaleLowerCase('en-NG');
}

function stateForCatalogName(name: string) {
  const key = stateCatalogKey(name);
  return NIGERIAN_STATES.find((state) => stateCatalogKey(state.name) === key);
}

export async function refreshNigerianLocationCatalog() {
  const catalog = await loadNigerianLocationCatalog();
  const states = await OperationState.find({ countryCode: 'NG' }).lean({ virtuals: true });
  const statesByKey = new Map(states.map((state: any) => [stateCatalogKey(state.name), state]));
  let created = 0;
  let updated = 0;
  let deactivated = 0;

  for (const entry of catalog) {
    const stateSeed = stateForCatalogName(entry.stateName);
    const state = statesByKey.get(stateCatalogKey(entry.stateName));
    if (!state || !stateSeed) continue;

    if (!state.capitalName || state.capitalName !== capitalForState(state.name)) {
      await OperationState.updateOne({ _id: state._id }, { $set: { capitalName: capitalForState(state.name) || stateSeed.capitalName } });
    }

    const names = Array.from(new Set(entry.lgas.map(normalizeLgaName).filter(Boolean)));
    const existingRows = await OperationLocalGovernment.find({ stateId: String(state._id) }).lean({ virtuals: true });
    const existingByName = new Map(existingRows.map((row: any) => [row.normalizedName, row]));
    const seen = new Set<string>();
    const now = new Date();
    const updates: any[] = [];
    const newNames: string[] = [];
    for (const name of names) {
      const key = normalizedName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = existingByName.get(key);
      if (existing) {
        updates.push({
          updateOne: {
            filter: { _id: existing._id },
            update: { $set: { name, status: 'active', source: entry.source, sourceUpdatedAt: now } },
          },
        });
        updated += 1;
      } else {
        newNames.push(name);
      }
    }
    const publicIds = await nextPublicIds('localGovernment', newNames.length);
    updates.push(...newNames.map((name, index) => ({
      insertOne: {
        document: {
          publicId: publicIds[index],
          stateId: String(state._id),
          name,
          normalizedName: normalizedName(name),
          status: 'active',
          source: entry.source,
          sourceUpdatedAt: now,
        },
      },
    })));
    if (updates.length) await OperationLocalGovernment.bulkWrite(updates, { ordered: true });
    created += newNames.length;

    const stale = await OperationLocalGovernment.updateMany(
      { stateId: String(state._id), source: { $ne: 'admin' }, normalizedName: { $nin: Array.from(seen) } },
      { $set: { status: 'inactive', sourceUpdatedAt: new Date() } },
    );
    deactivated += stale.modifiedCount;
  }

  return {
    states: states.length,
    catalogStates: catalog.length,
    created,
    updated,
    deactivated,
    total: await OperationLocalGovernment.countDocuments({ status: 'active' }),
  };
}
