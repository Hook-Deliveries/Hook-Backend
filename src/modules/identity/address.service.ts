import { isValidObjectId } from "mongoose";
import { CustomerAddress } from "@models/commerce/commerce.model";
import {
  OperationCity,
  OperationLocalGovernment,
  OperationState,
} from "@models/platform/geography.model";
import { nextPublicId } from "@modules/platform";
import { HttpError } from "@utils/http";

export type AddressInput = {
  label: string;
  recipientName: string;
  phone: string;
  line1: string;
  line2?: string;
  landmark?: string;
  stateId: string;
  cityId?: string;
  localGovernmentAreaId?: string;
  postalCode?: string;
  coordinates?: { latitude: number; longitude: number };
  formattedAddress?: string;
  stateCode: string;
  stateName: string;
  cityName: string;
  localGovernmentArea?: string;
  deliveryDistanceKm?: number;
  deliveryPricingSnapshot?: Record<string, unknown>;
  isDefault?: boolean;
};

function identity(id: string) {
  return isValidObjectId(id)
    ? { $or: [{ _id: id }, { publicId: id }] }
    : { publicId: id };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function persistedId(record: { _id?: unknown; id?: unknown } | null | undefined) {
  const value = record?.id ?? record?._id;
  return value == null ? undefined : String(value);
}

export class AddressService {
  async list(customerId: string) {
    return CustomerAddress.find({ customerId, status: "active" })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean({ virtuals: true });
  }

  async create(customerId: string, input: AddressInput) {
    const resolved = await this.validateCoverage(input);
    if (input.isDefault)
      await CustomerAddress.updateMany(
        { customerId, status: "active" },
        { $set: { isDefault: false } },
      );
    const count = await CustomerAddress.countDocuments({
      customerId,
      status: "active",
    });
    return CustomerAddress.create({
      publicId: await nextPublicId("address"),
      customerId,
      label: input.label,
      recipientName: input.recipientName,
      phone: input.phone,
      line1: input.line1,
      line2: input.line2,
      landmark: input.landmark,
      ...resolved,
      isDefault: input.isDefault || count === 0,
      status: "active",
    });
  }

  async update(customerId: string, id: string, input: Partial<AddressInput>) {
    const address = await CustomerAddress.findOne({
      ...identity(id),
      customerId,
      status: "active",
    });
    if (!address) throw new HttpError(404, "Address not found");
    const merged = { ...address.toObject(), ...input } as AddressInput;
    const resolved = await this.validateCoverage(merged, { allowLegacyLga: true });
    if (input.isDefault)
      await CustomerAddress.updateMany(
        { customerId, _id: { $ne: address.id }, status: "active" },
        { $set: { isDefault: false } },
      );
    Object.assign(address, {
      label: input.label ?? address.label,
      recipientName: input.recipientName ?? address.recipientName,
      phone: input.phone ?? address.phone,
      line1: input.line1 ?? address.line1,
      line2: input.line2 !== undefined ? input.line2 : address.line2,
      landmark: input.landmark !== undefined ? input.landmark : address.landmark,
      isDefault: input.isDefault ?? address.isDefault,
      ...resolved,
    });
    await address.save();
    return address.toJSON();
  }

  async archive(customerId: string, id: string) {
    const address = await CustomerAddress.findOne({
      ...identity(id),
      customerId,
      status: "active",
    });
    if (!address) throw new HttpError(404, "Address not found");
    address.status = "archived";
    address.isDefault = false;
    await address.save();
    if (
      !(await CustomerAddress.exists({
        customerId,
        status: "active",
        isDefault: true,
      }))
    ) {
      await CustomerAddress.findOneAndUpdate(
        { customerId, status: "active" },
        { $set: { isDefault: true } },
        { sort: { createdAt: -1 }, returnDocument: "after" },
      );
    }
    return { id: address.publicId, archived: true };
  }

  async setDefault(customerId: string, id: string) {
    const address = await CustomerAddress.findOne({
      ...identity(id),
      customerId,
      status: "active",
    });
    if (!address) throw new HttpError(404, "Address not found");
    await CustomerAddress.updateMany(
      { customerId, status: "active" },
      { $set: { isDefault: false } },
    );
    address.isDefault = true;
    await address.save();
    return address.toJSON();
  }

  async getOwned(customerId: string, id: string) {
    const address = await CustomerAddress.findOne({
      ...identity(id),
      customerId,
      status: "active",
    }).lean({ virtuals: true });
    if (!address) throw new HttpError(404, "Address not found");
    return address;
  }

  private async validateCoverage(input: AddressInput, options: { allowLegacyLga?: boolean } = {}) {
    const state = await OperationState.findOne({
      ...identity(input.stateId),
      countryCode: 'NG',
      status: "active",
    }).lean({ virtuals: true });
    if (!state)
      throw new HttpError(
        409,
        "Selected State is not active",
        undefined,
        "ADDRESS_OUTSIDE_COVERAGE",
      );
    if (state.deliveryEnabled === false)
      throw new HttpError(
        409,
        "Delivery is not available in this State",
        undefined,
        "ADDRESS_OUTSIDE_COVERAGE",
      );
    const stateDbId = persistedId(state) || state.publicId;
    const stateIds = [String(state._id), state.publicId].filter(Boolean);
    const localGovernmentArea = input.localGovernmentAreaId
      ? await OperationLocalGovernment.findOne({
          ...identity(input.localGovernmentAreaId),
          stateId: { $in: stateIds },
          status: 'active',
        }).lean({ virtuals: true })
      : input.localGovernmentArea
        ? await OperationLocalGovernment.findOne({
            stateId: { $in: stateIds },
            normalizedName: input.localGovernmentArea.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-NG'),
            status: 'active',
          }).lean({ virtuals: true })
        : undefined;
    if (input.localGovernmentAreaId && !localGovernmentArea)
      throw new HttpError(409, 'Selected Local Government Area is not available in the chosen State', undefined, 'ADDRESS_OUTSIDE_COVERAGE');
    if (!localGovernmentArea && !options.allowLegacyLga)
      throw new HttpError(409, 'Select a Local Government Area in the chosen State', undefined, 'ADDRESS_OUTSIDE_COVERAGE');
    const city = input.cityId
      ? await OperationCity.findOne({
          ...identity(input.cityId),
          stateId: { $in: stateIds },
          status: "active",
        }).lean({ virtuals: true })
      : await OperationCity.findOne({
          stateId: { $in: stateIds },
          status: "active",
          name: new RegExp(`^${escapeRegExp(input.cityName)}$`, "i"),
        }).lean({ virtuals: true });
    if (input.cityId && !city)
      throw new HttpError(409, "Selected city is not available in this State", undefined, "ADDRESS_OUTSIDE_COVERAGE");
    return {
      stateId: stateDbId,
      cityId: persistedId(city),
      localGovernmentAreaId: persistedId(localGovernmentArea) || input.localGovernmentAreaId,
      formattedAddress: input.formattedAddress || [input.line1, input.line2, input.landmark].filter(Boolean).join(', '),
      stateCode: state.code,
      stateName: state.name,
      cityName: input.cityName || state.capitalName || state.name,
      localGovernmentArea: localGovernmentArea?.name || input.localGovernmentArea,
      postalCode: input.postalCode,
      coordinates: input.coordinates,
    };
  }
}
