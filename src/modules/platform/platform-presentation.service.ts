import { isValidObjectId } from 'mongoose';
import { OperationCity, OperationState, ServiceZone } from '@models/platform/geography.model';
import { DispatchHub, Market } from '@models/platform/network.model';
import {
  MarketAssociateProfile,
  StaffProfile,
} from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { platformReferenceCache } from '@lib/ttl-cache';

type PlatformRecord = Record<string, any>;

const referenceModels = {
  accountId: User,
  createdBy: User,
  updatedBy: User,
  stateId: OperationState,
  cityId: OperationCity,
  zoneId: ServiceZone,
  hubId: DispatchHub,
  preferredHubId: DispatchHub,
  marketAssociateId: MarketAssociateProfile,
  marketId: Market,
} as const;

const referenceArrayModels = {
  stateIds: OperationState,
  assignedStateIds: OperationState,
  cityIds: OperationCity,
  zoneIds: ServiceZone,
  hubIds: DispatchHub,
  assignedHubIds: DispatchHub,
  marketIds: Market,
  staffIds: StaffProfile,
} as const;

function stringId(value: unknown) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && 'toString' in value) return value.toString();
  return String(value);
}

async function publicIdMap(model: any, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map<string, string>();
  const uniqueIds = [...new Set(ids)].sort();
  const cacheKey = `${model.modelName}:${uniqueIds.join(',')}`;
  const cached = platformReferenceCache.get(cacheKey);
  if (cached) return cached;
  const records = await model.find({ _id: { $in: uniqueIds } }).select('_id publicId').lean();
  const map = new Map<string, string>(
    records.map((record: any) => [record._id.toString(), record.publicId]),
  );
  return platformReferenceCache.set(cacheKey, map);
}

function referenceFilter(ids: string[]) {
  const publicIds = [...new Set(ids)];
  const objectIds = publicIds.filter((id) => isValidObjectId(id));
  const clauses: Record<string, unknown>[] = [{ publicId: { $in: publicIds } }];
  if (objectIds.length) clauses.push({ _id: { $in: objectIds } });
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function relationMap(records: any[]) {
  const map = new Map<string, any>();
  for (const record of records) {
    map.set(record._id.toString(), record);
    if (record.publicId) map.set(record.publicId, record);
  }
  return map;
}

/** Adds safe human-readable geography details to Market records for Admin and public catalog views. */
export async function presentMarketRecords(input: PlatformRecord | PlatformRecord[]): Promise<any> {
  const rawRecords = (Array.isArray(input) ? input : [input]).map((record) => ({ ...record }));
  const relationIds = (field: string) => rawRecords.map((record) => stringId(record[field])).filter(Boolean) as string[];
  const [states, cities, zones, hubs] = await Promise.all([
    OperationState.find(referenceFilter(relationIds('stateId'))).select('_id publicId name code').lean(),
    OperationCity.find(referenceFilter(relationIds('cityId'))).select('_id publicId name code stateId').lean(),
    ServiceZone.find(referenceFilter(relationIds('zoneId'))).select('_id publicId name code').lean(),
    DispatchHub.find(referenceFilter(relationIds('hubId'))).select('_id publicId name').lean(),
  ]);
  const stateMap = relationMap(states);
  const cityMap = relationMap(cities);
  const zoneMap = relationMap(zones);
  const hubMap = relationMap(hubs);
  const output = rawRecords.map((record: PlatformRecord, index) => {
    const presented = { ...record };
    for (const [field, map] of [['stateId', stateMap], ['cityId', cityMap], ['zoneId', zoneMap], ['hubId', hubMap]] as const) {
      const id = stringId(presented[field]);
      if (id) presented[field] = map.get(id) || id;
    }
    if (presented.publicId) presented.id = presented.publicId;
    delete presented._id;
    const raw = rawRecords[index];
    const state = stateMap.get(stringId(raw.stateId) || '');
    const city = cityMap.get(stringId(raw.cityId) || '');
    const zone = zoneMap.get(stringId(raw.zoneId) || '');
    const hub = hubMap.get(stringId(raw.hubId) || '');
    return {
      ...presented,
      state: state ? { publicId: state.publicId, name: state.name, code: state.code } : null,
      city: city ? { publicId: city.publicId, name: city.name, code: city.code } : null,
      zone: zone ? { publicId: zone.publicId, name: zone.name, code: zone.code } : null,
      hub: hub ? { publicId: hub.publicId, name: hub.name } : null,
      stateName: state?.name || null,
      cityName: city?.name || null,
      zoneName: zone?.name || null,
      hubName: hub?.name || null,
    };
  });
  return Array.isArray(input) ? output : output[0];
}

/**
 * Hub records with their State, City and linked Markets resolved to names.
 *
 * Hubs previously went through presentPlatformRecords, which only rewrites ids
 * to public ids. The admin UI reads `stateName`, `city.name` and a `markets[]`
 * array of objects, so every one of those fields was undefined and the page
 * showed "Not recorded" for data that was present — and, worse, showed
 * "3 Linked Markets" (from `marketIds.length`) directly above "No Markets are
 * connected yet" (from the absent `markets`).
 *
 * Builds on presentMarketRecords for the shared State/City lookup, then adds
 * the marketIds -> markets[] hydration hubs need.
 */
export async function presentHubRecords(input: PlatformRecord | PlatformRecord[]): Promise<any> {
  const rawRecords = (Array.isArray(input) ? input : [input]).map((record) => ({ ...record }));
  const presented = await presentMarketRecords(rawRecords);
  const presentedList: any[] = Array.isArray(presented) ? presented : [presented];

  // One batched lookup across every hub rather than a query per hub.
  const marketIds = [
    ...new Set(
      rawRecords.flatMap((record) => ((record.marketIds as unknown[]) || []).map((id) => stringId(id)).filter(Boolean) as string[]),
    ),
  ];
  const markets = marketIds.length
    ? await Market.find(referenceFilter(marketIds)).select('_id publicId name address').lean()
    : [];
  const marketMap = relationMap(markets);

  const output = presentedList.map((record, index) => {
    const ids = ((rawRecords[index].marketIds as unknown[]) || []).map((id) => stringId(id)).filter(Boolean) as string[];
    const linked = ids.map((id) => marketMap.get(id)).filter(Boolean) as any[];
    return {
      ...record,
      // Public ids, so the UI links resolve.
      marketIds: linked.length ? linked.map((market) => market.publicId) : record.marketIds,
      markets: linked.map((market) => ({ publicId: market.publicId, id: market.publicId, name: market.name, address: market.address })),
    };
  });

  return Array.isArray(input) ? output : output[0];
}

/**
 * Converts persistence references to stable public identifiers at the HTTP boundary.
 * Role IDs remain internal because roles intentionally do not have a Hook public ID.
 */
export async function presentPlatformRecords(input: PlatformRecord | PlatformRecord[]): Promise<any> {
  const records = (Array.isArray(input) ? input : [input]).map((record) => ({ ...record }));
  const maps: Record<string, Map<string, string>> = {};

  await Promise.all([
    ...Object.entries(referenceModels).map(async ([field, model]) => {
      const ids = records.map((record) => stringId(record[field])).filter(Boolean) as string[];
      maps[field] = await publicIdMap(model, [...new Set(ids)]);
    }),
    ...Object.entries(referenceArrayModels).map(async ([field, model]) => {
      const ids = records.flatMap((record) =>
        Array.isArray(record[field]) ? record[field].map(stringId).filter(Boolean) : [],
      ) as string[];
      maps[field] = await publicIdMap(model, [...new Set(ids)]);
    }),
  ]);

  const presented = records.map((record) => {
    const output = { ...record };
    for (const field of Object.keys(referenceModels)) {
      const id = stringId(output[field]);
      if (id) output[field] = maps[field].get(id) || id;
    }
    for (const field of Object.keys(referenceArrayModels)) {
      if (Array.isArray(output[field])) {
        output[field] = output[field].map((value: unknown) => {
          const id = stringId(value)!;
          return maps[field].get(id) || id;
        });
      }
    }
    if (output.publicId) output.id = output.publicId;
    delete output._id;
    return output;
  });

  return Array.isArray(input) ? presented : presented[0];
}
