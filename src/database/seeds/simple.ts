import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

import { connectDatabase, disconnectDatabase } from '@config/data-source';
import {
  AccountStatus,
  AccountType,
  ProductAvailabilityStatus,
  ProductStatus,
  ProductSubmissionStatus,
  ScopeType,
  UserRole,
} from '@lib/constants';
import { NIGERIAN_STATES } from '@lib/nigeria-states';
import { hashPassword } from '@lib/security';
import { Category } from '@models/categories/category.model';
import { CommercePolicyVersion, CommerceSettings } from '@models/commerce/commerce.model';
import { Cart } from '@models/cart/cart.model';
import { CartItem } from '@models/cart/cart-item.model';
import { CatalogMediaAsset, ProductSubmission, ProductVariant } from '@models/catalog/catalog.model';
import { MarketVendor, VendorCollection, VendorInvitation, VendorPaymentRecord } from '@models/catalog/market-vendor.model';
import { OperationCity, OperationState } from '@models/platform/geography.model';
import { DeliveryPricingRule } from '@models/platform/delivery-pricing.model';
import { DispatchHub, Market } from '@models/platform/network.model';
import { Role } from '@models/platform/access.model';
import {
  HookPartner,
  MarketAssociateMarketAssignment,
  MarketAssociateProfile,
  StaffProfile,
} from '@models/platform/operations-accounts.model';
import { OperationalState } from '@models/operations/operational-state.model';
import { Product } from '@models/products/product.model';
import { User } from '@models/users/user.model';
import { ensurePlatformAccessCatalog } from '@modules/platform/platform-bootstrap.service';
import { hookIdFromPublicId, nextPublicIds, nextPublicId } from '@modules/platform/public-id.service';
import { refreshNigerianLocationCatalog } from '@services/location-catalog.service';
import { encryptVendorAccountNumber } from '@lib/vendor-payment-crypto';
import { productGallery, productOptions, MARKET_ASSOCIATE_PRODUCT_CATALOG } from './market-associate-product-catalog';

dotenv.config({ quiet: true });

const CATEGORY_SEEDS = [
  ['Sneakers', 'sneakers', 'Everyday, running, and fashion sneakers.', 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500&auto=format&fit=crop&q=80'],
  ['Streetwear', 'streetwear', 'Urban apparel and casual fashion.', 'https://images.unsplash.com/photo-1523398002811-999ca8dec234?w=500&auto=format&fit=crop&q=80'],
  ['Accessories', 'accessories', 'Bags, caps, socks, and finishing items.', 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=500&auto=format&fit=crop&q=80'],
  ['Dresses', 'dresses', 'Everyday, evening, and occasion dresses.', 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=500&auto=format&fit=crop&q=80'],
  ['Bags', 'bags', 'Handbags, totes, and everyday carry.', 'https://images.unsplash.com/photo-1566150905458-1bf1fc113f0d?w=500&auto=format&fit=crop&q=80'],
] as const;

const MARKET_SEEDS = [
  { stateCode: 'LA', city: 'Lagos', cityCode: 'LOS', market: 'Balogun Market', address: 'Balogun Market, Lagos Island', color: '#FF5A19', priority: 1, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786737693/hook/sfal3eilrlzfnyqpxklk.jpg' },
  { stateCode: 'LA', city: 'Lagos', cityCode: 'LOS', market: 'Tejuosho Market', address: 'Tejuosho Road, Yaba', color: '#48C7E8', priority: 2, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786737770/hook/jpaiy0iikjagvqpq4eau.jpg' },
  { stateCode: 'LA', city: 'Lagos', cityCode: 'LOS', market: 'Mandilas Market', address: 'Mandilas, Lagos Island', color: '#F15AC8', priority: 3, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786738247/hook/ynjxnerrdn5mml3bc55j.jpg' },
  { stateCode: 'LA', city: 'Lagos', cityCode: 'LOS', market: 'Tradefair Market', address: 'Trade Fair Complex, Lagos', color: '#F3A7D9', priority: 10, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786741425/hook/gdveeddjd2zfuyxan4mz.jpg' },
  { stateCode: 'OY', city: 'Ibadan', cityCode: 'IBD', market: 'Bodija Market', address: 'Bodija, Ibadan', color: '#269AF2', priority: 20, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786717010/hook/ap0lvsftv8maxog3qccq.jpg' },
  { stateCode: 'RI', city: 'Port Harcourt', cityCode: 'PHC', market: 'Mile One Market', address: 'Ikwerre Road, Port Harcourt', color: '#FF8A62', priority: 30, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786717107/hook/lgscio2wfi8nuvzz5mal.jpg' },
  { stateCode: 'FC', city: 'Abuja', cityCode: 'ABV', market: 'Wuse Market', address: 'Wuse Zone 5, Abuja', color: '#FFC809', priority: 40, image: 'https://res.cloudinary.com/df4f0usnh/image/upload/v1786718127/hook/bdnnhdz3fpahthumnn4h.jpg' },
] as const;

function assertSeedResetAllowed() {
  const environment = String(process.env.NODE_ENV || '').toLowerCase();
  if (!['development', 'test'].includes(environment) && process.env.ALLOW_DESTRUCTIVE_SEED !== 'true') {
    throw new Error('Refusing to reset this database. Use NODE_ENV=development or set ALLOW_DESTRUCTIVE_SEED=true after verifying the target database.');
  }
}

function seedPassword() {
  const configured = process.env.SEED_ADMIN_PASSWORD
    || process.env.SEED_ADMIN_PASSWROD
    || process.env.SEED_PASSWORD;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SEED_ADMIN_PASSWORD is required for a production seed.');
  }
  return 'SEED_ADMIN_PASSWROD';
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function idOf(record: { _id?: unknown; id?: string }) {
  return String(record.id || record._id || '');
}

async function seedStates() {
  const publicIds = await nextPublicIds('state', NIGERIAN_STATES.length);
  const stateRows = NIGERIAN_STATES.map((state, index) => ({
    publicId: publicIds[index],
    ...state,
    countryCode: 'NG',
    status: 'active' as const,
    deliveryEnabled: true,
    operationsEnabled: false,
    timezone: 'Africa/Lagos',
    currency: 'NGN',
    deliveryPromiseHours: 48,
    payAtHubEnabled: false,
    payAtHubLimitMinor: 10_000_000,
    podEnabled: false,
    podLimitMinor: 10_000_000,
  }));
  const states = await OperationState.insertMany(stateRows);
  await OperationalState.insertMany(NIGERIAN_STATES.map((state) => ({
    ...state,
    countryCode: 'NG',
    countryName: 'Nigeria',
    isEnabled: true,
    enabledAt: new Date(),
  })));
  return states;
}

async function seedAdmin(password: string) {
  await ensurePlatformAccessCatalog();
  const role = await Role.findOne({ key: 'SUPER_ADMIN', isActive: true }).lean();
  if (!role) throw new Error('SUPER_ADMIN role was not created');
  const user = await User.create({
    publicId: await nextPublicId('staff'),
    email: process.env.SEED_ADMIN_EMAIL || 'admin@gmail.com',
    phone: process.env.SEED_ADMIN_PHONE || '+2348000000000',
    password,
    firstName: process.env.SEED_ADMIN_FIRST_NAME || 'Hook',
    lastName: process.env.SEED_ADMIN_LAST_NAME || 'Admin',
    role: UserRole.SUPER_ADMIN,
    accountType: AccountType.STAFF,
    accountStatus: AccountStatus.ACTIVE,
    roleIds: [String(role._id)],
    scopeType: ScopeType.GLOBAL,
    assignedStateIds: [],
    assignedHubIds: [],
    permissions: role.permissionKeys,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    passwordChangedAt: new Date(),
  });
  await StaffProfile.create({
    publicId: user.publicId,
    accountId: idOf(user),
    roleIds: [String(role._id)],
    scopeType: ScopeType.GLOBAL,
    stateIds: [],
    hubIds: [],
    status: 'active',
  });
  return user;
}

const STAFF_ACCOUNT_SEEDS = [
  ['OPERATIONS_LEAD', 'operationslead@gmail.com', 'Operations', 'Lead'],
  ['STATE_OPERATIONS_MANAGER', 'statemanager@gmail.com', 'State', 'Manager'],
  ['COMMERCIAL_MANAGER', 'commercialmanager@gmail.com', 'Commercial', 'Manager'],
  ['COMMERCIAL_OFFICER', 'commercialofficer@gmail.com', 'Commercial', 'Officer'],
  ['CATALOG_REVIEWER', 'catalogreviewer@gmail.com', 'Catalog', 'Reviewer'],
  ['DISPATCH_HUB_MANAGER', 'hubmanager@gmail.com', 'Hub', 'Manager'],
  ['DISPATCH_HUB_OFFICER', 'hubofficer@gmail.com', 'Hub', 'Officer'],
  ['LOGISTICS_OFFICER', 'logisticsofficer@gmail.com', 'Logistics', 'Officer'],
  ['CUSTOMER_SUPPORT_OFFICER', 'supportofficer@gmail.com', 'Customer Support', 'Officer'],
  ['FINANCE_OFFICER', 'financeofficer@gmail.com', 'Finance', 'Officer'],
  ['MANAGEMENT_VIEWER', 'managementviewer@gmail.com', 'Management', 'Viewer'],
] as const;

function scopeForRole(role: { defaultScopeType: string }, states: any[], markets: any[]) {
  const stateIds = states.map((state) => idOf(state));
  const hubIds = [...new Set(markets.map((market) => String(market.hubId || '')).filter(Boolean))];
  const firstStateId = stateIds[0];
  const firstHubId = hubIds[0];

  if (role.defaultScopeType === ScopeType.GLOBAL) return { stateIds: [], hubIds: [] };
  if (role.defaultScopeType === ScopeType.HUB) {
    return { stateIds: firstStateId ? [firstStateId] : [], hubIds: firstHubId ? [firstHubId] : [] };
  }
  if (role.defaultScopeType === ScopeType.SINGLE_STATE) {
    return { stateIds: firstStateId ? [firstStateId] : [], hubIds: firstHubId ? [firstHubId] : [] };
  }
  return { stateIds, hubIds };
}

async function createStaffAccount(input: {
  role: any;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  states: any[];
  markets: any[];
  password: string;
}) {
  const scope = scopeForRole(input.role, input.states, input.markets);
  const publicId = await nextPublicId('staff');
  const user = await User.create({
    publicId,
    email: input.email,
    phone: input.phone,
    password: input.password,
    firstName: input.firstName,
    lastName: input.lastName,
    role: UserRole.ADMIN,
    accountType: AccountType.STAFF,
    accountStatus: AccountStatus.ACTIVE,
    roleIds: [idOf(input.role)],
    scopeType: input.role.defaultScopeType,
    assignedStateIds: scope.stateIds,
    assignedHubIds: scope.hubIds,
    permissions: input.role.permissionKeys,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    passwordChangedAt: new Date(),
  });
  await StaffProfile.create({
    publicId,
    accountId: idOf(user),
    roleIds: [idOf(input.role)],
    scopeType: input.role.defaultScopeType,
    stateIds: scope.stateIds,
    hubIds: scope.hubIds,
    status: 'active',
  });
  return user;
}

async function seedStaffAccounts(states: any[], markets: any[], password: string) {
  const roles = await Role.find({
    key: { $in: STAFF_ACCOUNT_SEEDS.map(([key]) => key) },
    isActive: true,
  }).lean();
  const rolesByKey = new Map(roles.map((role) => [role.key, role]));
  const users: any[] = [];
  for (let index = 0; index < STAFF_ACCOUNT_SEEDS.length; index += 1) {
    const [key, email, firstName, lastName] = STAFF_ACCOUNT_SEEDS[index];
    const role = rolesByKey.get(key);
    if (!role) throw new Error(`Seed role ${key} was not created`);
    users.push(await createStaffAccount({
      role,
      email,
      firstName,
      lastName,
      phone: `+234801${String(index + 1).padStart(7, '0')}`,
      states,
      markets,
      password,
    }));
  }
  return users;
}

async function seedNonStaffAccounts(adminId: string, markets: any[], password: string) {
  const market = markets[0];
  if (!market) throw new Error('At least one market is required for Market Associate and Partner seed accounts');

  const marketAssociatePublicId = await nextPublicId('marketAssociate');
  const marketAssociateAccount = await User.create({
    publicId: marketAssociatePublicId,
    email: 'runner@gmail.com',
    phone: '+2348020000001',
    password,
    firstName: 'Hook',
    lastName: 'Market Associate',
    role: UserRole.MARKETASSOCIATE,
    accountType: AccountType.MARKETASSOCIATE,
    accountStatus: AccountStatus.ACTIVE,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    passwordChangedAt: new Date(),
  });
  const marketAssociateProfile = await MarketAssociateProfile.create({
    publicId: marketAssociatePublicId,
    accountId: idOf(marketAssociateAccount),
    stateIds: [String(market.stateId)],
    hubIds: market.hubId ? [String(market.hubId)] : [],
    availability: 'available',
    status: 'active',
  });
  await MarketAssociateMarketAssignment.create({
    marketAssociateId: idOf(marketAssociateProfile),
    marketId: idOf(market),
    stateId: String(market.stateId),
    preferredHubId: market.hubId ? String(market.hubId) : undefined,
    priority: 1,
    isPrimary: true,
    status: 'active',
    activeFrom: new Date(),
    assignmentReason: 'Default development seed assignment',
    createdBy: adminId,
    history: [],
  });

  const partnerPublicId = await nextPublicId('partner');
  const partner = await User.create({
    publicId: partnerPublicId,
    email: 'partner@gmail.com',
    phone: '+2348020000002',
    password,
    firstName: 'Hook',
    lastName: 'Partner',
    role: UserRole.PARTNER,
    accountType: AccountType.PARTNER,
    accountStatus: AccountStatus.ACTIVE,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    passwordChangedAt: new Date(),
  });
  await HookPartner.create({
    publicId: partnerPublicId,
    accountId: idOf(partner),
    name: 'Hook Partner Lagos Island',
    stateId: String(market.stateId),
    cityId: String(market.cityId),
    address: market.address,
    coordinates: market.coordinates,
    contact: { email: partner.email, phone: partner.phone },
    status: 'active',
  });

  const customer = await User.create({
    publicId: await nextPublicId('customer'),
    email: 'customer@gmail.com',
    phone: '+2348020000003',
    password: await hashPassword(seedPassword()),
    firstName: 'Hook',
    lastName: 'Customer',
    role: UserRole.SHOPPER,
    accountType: AccountType.CUSTOMER,
    accountStatus: AccountStatus.ACTIVE,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    podEligible: true,
    passwordChangedAt: new Date(),
  });

  return { marketAssociateAccount, marketAssociateProfile, partner, customer };
}

async function seedCategories() {
  const publicIds = await nextPublicIds('category', CATEGORY_SEEDS.length);
  return Category.insertMany(CATEGORY_SEEDS.map(([name, slug, description, iconUrl], index) => ({
    publicId: publicIds[index], name, slug, description, iconUrl, sortOrder: index + 1, isActive: true,
  })));
}

async function seedNetwork(states: any[]) {
  const stateByCode = new Map(states.map((state) => [state.code, state]));
  const markets: any[] = [];
  const networkByCity = new Map<string, { city: any; hub: any }>();
  for (const entry of MARKET_SEEDS) {
    const state = stateByCode.get(entry.stateCode);
    if (!state) continue;
    const networkKey = `${entry.stateCode}:${entry.cityCode}`;
    let network = networkByCity.get(networkKey);
    if (!network) {
      const city = await OperationCity.create({
        publicId: await nextPublicId('city'), stateId: idOf(state), name: entry.city, code: entry.cityCode, status: 'active',
      });
      const hub = await DispatchHub.create({
        publicId: await nextPublicId('hub'), stateId: idOf(state), cityId: idOf(city), zoneIds: [], name: `${entry.city} Dispatch Hub`, address: entry.address, coordinates: entry.stateCode === 'LA' ? { lat: 6.45, lng: 3.39 } : undefined, marketIds: [], staffIds: [], status: 'active',
      });
      city.defaultHubId = idOf(hub);
      await city.save();
      network = { city, hub };
      networkByCity.set(networkKey, network);
    }
    const { city, hub } = network;
    const market = await Market.create({
      publicId: await nextPublicId('market'), name: entry.market, normalizedName: entry.market.toLowerCase(), stateId: idOf(state), cityId: idOf(city), hubId: idOf(hub), address: entry.address, imageUrl: entry.image, shortDisplayName: entry.market.replace(' Market', '\nMarket'), discoveryColor: entry.color, isFeatured: entry.priority < 10, displayPriority: entry.priority, status: 'active',
    });
    hub.marketIds = [...new Set([...(hub.marketIds || []), idOf(market)])];
    await hub.save();
    markets.push(market);
  }
  return markets;
}

async function seedMarketVendors(markets: any[], marketAssociateProfile: any) {
  const vendorIds = await nextPublicIds('marketVendor', markets.length + 2);
  const invitationIds = await nextPublicIds('vendorInvitation', markets.length + 2);
  const vendors: any[] = [];
  let invitationIndex = 0;
  for (let marketIndex = 0; marketIndex < markets.length; marketIndex += 1) {
    const market = markets[marketIndex];
    const vendorCount = marketIndex < 2 ? 2 : 1;
    for (let vendorIndex = 0; vendorIndex < vendorCount; vendorIndex += 1) {
      const businessName = `${market.name.split(' Market')[0]} ${vendorIndex === 0 ? 'Style House' : 'Essentials Stall'}`;
      const vendor = await MarketVendor.create({
        publicId: vendorIds[vendors.length],
        marketId: idOf(market),
        stateId: String(market.stateId),
        businessName,
        contactName: vendorIndex === 0 ? 'Amina Yusuf' : 'Chinedu Okafor',
        normalizedPhone: `0803000${String(100 + vendors.length).padStart(4, '0')}`,
        phone: `0803000${String(100 + vendors.length).padStart(4, '0')}`,
        email: `supplier${vendors.length + 1}@hook.local`,
        address: market.address,
        preferredContactChannel: vendorIndex === 0 ? 'phone' : 'email',
        paymentProfile: {
          method: vendorIndex === 0 ? 'bank_transfer' : 'cash',
          bankName: vendorIndex === 0 ? 'Hook Development Bank' : undefined,
          bankCode: vendorIndex === 0 ? '000001' : undefined,
          accountName: vendorIndex === 0 ? businessName : undefined,
          accountNumberEncrypted: vendorIndex === 0 ? encryptVendorAccountNumber(`012345678${String(vendors.length + 1).padStart(2, '0')}`) : undefined,
          accountNumberLast4: vendorIndex === 0 ? `${String(vendors.length + 1).padStart(2, '0')}01` : undefined,
          verificationStatus: vendorIndex === 0 ? 'verified' : 'unverified',
          updatedAt: new Date(),
        },
        status: vendorIndex === 0 ? 'active' : 'pending',
        consentAt: vendorIndex === 0 ? new Date() : undefined,
        invitedByMarketAssociateId: idOf(marketAssociateProfile),
      });
      const token = crypto.randomBytes(32).toString('hex');
      await VendorInvitation.create({
        publicId: invitationIds[invitationIndex],
        vendorId: idOf(vendor),
        marketId: idOf(market),
        invitedByMarketAssociateId: idOf(marketAssociateProfile),
        email: vendor.email,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        status: vendorIndex === 0 ? 'accepted' : 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        acceptedAt: vendorIndex === 0 ? new Date() : undefined,
        emailSentAt: vendorIndex === 0 ? new Date() : undefined,
      });
      invitationIndex += 1;
      vendors.push(vendor);
    }
  }
  return vendors;
}

async function seedProducts(categories: any[], markets: any[], states: any[], adminId: string, vendors: any[], marketAssociateProfile: any) {
  const categoryBySlug = new Map(categories.map((category) => [category.slug, category]));
  const stateById = new Map(states.map((state) => [idOf(state), state]));
  const productIds = await nextPublicIds('product', MARKET_ASSOCIATE_PRODUCT_CATALOG.length);
  const products: any[] = [];
  for (let index = 0; index < MARKET_ASSOCIATE_PRODUCT_CATALOG.length; index += 1) {
    const seed = MARKET_ASSOCIATE_PRODUCT_CATALOG[index];
    const { title, costPrice: basePrice, sellingPrice, floorPrice, quantity, categorySlug } = seed;
    const market = markets[index % markets.length];
    const state = stateById.get(String(market.stateId));
    const marketVendors = vendors.filter((vendor) => vendor.marketId === idOf(market));
    const marketVendor = marketVendors[index % Math.max(marketVendors.length, 1)] || vendors[0];
    const basePriceMinor = basePrice * 100;
    const sellingPriceMinor = sellingPrice * 100;
    const discountMinor = index % 4 === 0 ? Math.round(sellingPriceMinor * 0.08) : 0;
    const submission = await ProductSubmission.create({
      publicId: await nextPublicId('submission'),
      marketAssociateId: idOf(marketAssociateProfile),
      marketId: idOf(market),
      marketVendorId: idOf(marketVendor),
      sourceStateId: idOf(state),
      categorySuggestionId: idOf(categoryBySlug.get(categorySlug)),
      basicTitle: title,
      notes: 'Seeded Market Associate capture for development verification.',
      mediaIds: [],
      basePriceMinor,
      currency: 'NGN',
      variants: productOptions(seed),
      availabilityStatus: ProductAvailabilityStatus.AVAILABLE,
      status: ProductSubmissionStatus.APPROVED,
      reviewNotes: [],
      submittedAt: new Date(),
      reviewedAt: new Date(),
      reviewedBy: adminId,
      version: 1,
    });
    const images = productGallery(seed);
    const media = await CatalogMediaAsset.insertMany(images.map((url, mediaIndex) => ({
      publicId: `MED-SEED-${slugify(title)}-${mediaIndex + 1}`,
      provider: 'legacy_external',
      providerPublicId: `unsplash/${slugify(title)}/${mediaIndex + 1}`,
      resourceType: 'image',
      deliveryType: 'external',
      secureUrl: url,
      format: 'jpg',
      width: 1200,
      height: 1200,
      bytes: 1,
      uploaderAccountId: String(marketAssociateProfile.accountId),
      ownerType: 'submission',
      ownerId: idOf(submission),
      uploadIntentId: `seed-${slugify(title)}-${mediaIndex + 1}`,
      status: 'ready',
      order: mediaIndex,
      metadata: { source: 'unsplash', seeded: true },
    })));
    submission.mediaIds = media.map((asset) => asset.publicId);
    const availabilityStatus = ProductAvailabilityStatus.AVAILABLE;
    const product = await Product.create({
      publicId: productIds[index],
      hookId: hookIdFromPublicId(productIds[index]),
      title,
      slug: slugify(title),
      description: seed.description,
      costPrice: basePrice,
      sellingPrice,
      discountedPrice: discountMinor ? sellingPrice - discountMinor / 100 : undefined,
      minAcceptablePrice: floorPrice,
      basePriceMinor,
      sellingPriceMinor,
      markupMinor: sellingPriceMinor - basePriceMinor,
      discountMinor,
      currency: 'NGN',
      sourceStateId: idOf(state),
      marketId: idOf(market),
      sourceSubmissionId: idOf(submission),
      sourceMarketVendorId: idOf(marketVendor),
      sourceMarketAssociateId: idOf(marketAssociateProfile),
      categoryId: idOf(categoryBySlug.get(categorySlug)),
      quantity,
      reservedQuantity: 0,
      colors: seed.colors,
      sizes: seed.sizes,
      images,
      mediaAssetIds: [],
      negotiationRules: { enabled: true, minimumNegotiablePriceMinor: floorPrice * 100, maximumDiscountMinor: sellingPriceMinor - floorPrice * 100, maximumCustomerOffers: 3, acceptedQuoteExpiryMinutes: 30 },
      availabilityStatus,
      customerAvailabilityNote: 'Available from a verified Hook Market.',
      lastMarketVerifiedAt: new Date(),
      lastPriceVerifiedAt: new Date(),
      lastAvailabilityConfirmedAt: new Date(),
      availabilityValidUntil: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
      publishedAt: new Date(Date.now() - index * 60_000),
      publishedBy: adminId,
      commercialApproval: { approved: true, approvedBy: adminId, approvedAt: new Date() },
      catalogMigrationVersion: 3,
      catalogVersion: 1,
      status: ProductStatus.PUBLISHED,
      viewCount: 0,
      orderCount: 0,
      averageRating: 4.6,
      source: 'field_agent',
    });
    submission.productId = idOf(product);
    await submission.save();
    const options = productOptions(seed);
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      await ProductVariant.create({
        publicId: await nextPublicId('variant'),
        productId: idOf(product),
        sku: `${product.hookId}-${String(optionIndex + 1).padStart(2, '0')}`,
        ...options[optionIndex],
        mediaAssetIds: [],
      });
    }
    products.push(product);
    if (index < 3) {
      const collection = await VendorCollection.create({
        publicId: await nextPublicId('vendorCollection'),
        marketVendorId: idOf(marketVendor),
        marketId: idOf(market),
        marketAssociateId: idOf(marketAssociateProfile),
        productSubmissionId: idOf(submission),
        productId: idOf(product),
        productTitleSnapshot: title,
        quantity: Math.min(quantity, 3),
        actualCostMinor: basePriceMinor * Math.min(quantity, 3),
        currency: 'NGN',
        status: 'collected',
        paymentStatus: index === 0 ? 'recorded' : 'reconciled',
        collectedAt: new Date(Date.now() - index * 60 * 60 * 1000),
        evidenceAssetIds: [],
      });
      await VendorPaymentRecord.create({
        publicId: await nextPublicId('vendorPayment'),
        collectionId: idOf(collection),
        marketVendorId: idOf(marketVendor),
        marketId: idOf(market),
        marketAssociateId: idOf(marketAssociateProfile),
        amountMinor: collection.actualCostMinor,
        currency: 'NGN',
        method: index === 0 ? 'cash' : 'bank_transfer',
        status: index === 0 ? 'recorded' : 'reconciled',
        proofAssetIds: [],
        recordedAt: collection.collectedAt,
        reconciledAt: index === 0 ? undefined : new Date(),
        reconciledBy: index === 0 ? undefined : adminId,
      });
    }
  }
  return products;
}

async function seedCommerceDefaults(adminId: string) {
  const policyVersions = Object.fromEntries(await Promise.all((['TERMS', 'PRIVACY', 'RETURNS'] as const).map(async (type) => {
    const version = '2026.08';
    await CommercePolicyVersion.create({ publicId: `POL-${type}-${version.replace('.', '-')}`, type, version, status: 'active', effectiveAt: new Date() });
    return [type, version];
  })));
  await CommerceSettings.create({ key: 'commerce', currency: 'NGN', defaultDeliveryFeeMinor: 300_000, podEnabled: false, defaultPodLimitMinor: 10_000_000, previewTtlMinutes: 10, catalogAvailabilityCheckDays: 4, negotiationEnabled: true, negotiationSessionMode: 'fixed', negotiationSessionMinutes: 10, negotiationMaximumOffers: 3, negotiationQuoteMinutes: 30, negotiationAzureWordingEnabled: true, paymentProviders: [{ provider: 'paystack', enabled: true, displayOrder: 1, isDefault: true }], activePolicyVersions: policyVersions, updatedBy: adminId });
  await DeliveryPricingRule.create({
    publicId: await nextPublicId('deliveryRule'), name: 'Nigeria default delivery', scope: 'global', mode: 'flat', flatFeeMinor: 300_000, fallbackFeeMinor: 300_000, status: 'active', version: 1, createdBy: adminId,
  });
}

async function seedCustomerCart(customer: any, products: any[]) {
  const selected: any[] = [];
  for (const product of products) {
    if (!selected.some((item) => String(item.sourceStateId) === String(product.sourceStateId))) {
      selected.push(product);
    }
    if (selected.length === 2) break;
  }
  if (!selected.length) return;
  const subtotalMinor = selected.reduce((sum, product) => sum + Number(product.effectivePriceMinor || product.sellingPriceMinor || 0), 0);
  const cart = await Cart.create({
    publicId: await nextPublicId('cart'),
    ownerType: 'customer',
    customerId: idOf(customer),
    userId: idOf(customer),
    version: 1,
    status: 'active',
    subtotal: subtotalMinor / 100,
    deliveryFee: 0,
    total: subtotalMinor / 100,
    isCheckedOut: false,
  });
  for (const product of selected) {
    const variant = await ProductVariant.findOne({ productId: idOf(product), active: true }).lean();
    const unitPriceMinor = Number(product.effectivePriceMinor || product.sellingPriceMinor || 0);
    await CartItem.create({
      publicId: await nextPublicId('cartItem'),
      cartId: idOf(cart),
      productId: idOf(product),
      quantity: 1,
      unitPrice: unitPriceMinor / 100,
      totalPrice: unitPriceMinor / 100,
      selectedVariants: { color: '#111111', size: '42' },
      variantKey: variant ? idOf(variant) : 'default',
      variantId: variant ? idOf(variant) : undefined,
      marketId: String(product.marketId),
      stateId: String(product.sourceStateId),
      unitPriceMinor,
      totalPriceMinor: unitPriceMinor,
      currency: 'NGN',
      productVersion: Number(product.catalogVersion || 1),
    });
  }
}

export async function runSimpleSeed() {
  assertSeedResetAllowed();
  await connectDatabase();
  const databaseName = mongoose.connection.db?.databaseName || 'unknown';
  console.warn(`Hook seed: resetting development database "${databaseName}"`);
  await mongoose.connection.dropDatabase();

  const password = await hashPassword(seedPassword());
  const admin = await seedAdmin(password);
  const states = await seedStates();
  const locationResult = await refreshNigerianLocationCatalog();
  const categories = await seedCategories();
  const markets = await seedNetwork(states);
  const operatingStateIds = [...new Set(markets.map((market) => String(market.stateId)))];
  if (operatingStateIds.length) {
    await OperationState.updateMany(
      { _id: { $in: operatingStateIds } },
      { $set: { operationsEnabled: true } },
    );
  }
  const staff = await seedStaffAccounts(states, markets, password);
  const accounts = await seedNonStaffAccounts(idOf(admin), markets, password);
  const vendors = await seedMarketVendors(markets, accounts.marketAssociateProfile);
  const products = await seedProducts(categories, markets, states, idOf(admin), vendors, accounts.marketAssociateProfile);
  await seedCommerceDefaults(idOf(admin));
  await seedCustomerCart(accounts.customer, products);

  console.log('Hook seed completed');
  console.log(`  Admin: ${admin.email}`);
  console.log(`  Staff accounts: ${staff.length + 1}`);
  console.log('  Market Associate: runner@gmail.com');
  console.log('  Partner: partner@gmail.com');
  console.log('  Customer: customer@gmail.com');
  console.log('  Shared password: SEED_ADMIN_PASSWORD (or SEED_ADMIN_PASSWROD) from the environment');
  console.log(`  States: ${states.length} enabled for delivery`);
  console.log(`  LGAs: ${locationResult.total} active`);
  console.log(`  Markets: ${markets.length}`);
  console.log(`  Market vendors: ${vendors.length}`);
  console.log(`  Categories: ${categories.length}`);
  console.log(`  Published products: ${products.length}`);
  console.log('  Customer cart: multi-state sample ready');
}

if (require.main === module) {
  runSimpleSeed()
    .catch((error) => {
      console.error('Hook seed failed');
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnectDatabase().catch(() => undefined);
    });
}
