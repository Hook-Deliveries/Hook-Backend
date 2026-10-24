import { DEFAULT_OPERATIONAL_STATE_CODE, NIGERIAN_STATES } from '@lib/nigeria-states';
import { OperationalState } from '@models/operations/operational-state.model';
import { HttpError } from '@utils/http';

export function normalizeStateCode(code?: unknown): string | undefined {
  return typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : undefined;
}

export async function ensureOperationalStatesCatalog() {
  const existing = await OperationalState.findOne().select('_id').lean();
  if (existing) return;

  await OperationalState.insertMany(NIGERIAN_STATES.map((state) => ({
    ...state,
    countryCode: 'NG',
    countryName: 'Nigeria',
    isEnabled: state.code === DEFAULT_OPERATIONAL_STATE_CODE,
    enabledAt: state.code === DEFAULT_OPERATIONAL_STATE_CODE ? new Date() : undefined,
  })));
}

export async function resolveActiveOperationalState(code?: unknown) {
  const stateCode = normalizeStateCode(code);
  if (!stateCode) throw new HttpError(400, 'Operating state is required');

  const state = await OperationalState.findOne({ code: stateCode }).lean({ virtuals: true });
  if (!state) throw new HttpError(400, 'Unknown operating state');
  if (!state.isEnabled) throw new HttpError(400, `${state.name} is not enabled for Hook operations`);

  return {
    stateCode: state.code,
    stateName: state.name,
  };
}
