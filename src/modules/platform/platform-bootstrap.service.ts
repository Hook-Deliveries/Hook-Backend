import { ScopeType } from '@lib/constants';
import { Permission, Role } from '@models/platform/access.model';

const domains: Record<string, string[]> = {
  staff: ['view', 'create', 'edit', 'suspend', 'revoke_sessions'],
  roles: ['view', 'manage'],
  states: ['view', 'manage'],
  cities: ['view', 'manage'],
  zones: ['view', 'manage'],
  markets: ['view', 'manage', 'assign_hub'],
  hubs: ['view', 'manage', 'assign_markets'],
  categories: ['view', 'manage'],
  partners: ['view', 'manage'],
  runners: ['view', 'manage', 'assign'],
  orders: ['view', 'create', 'edit', 'cancel'],
  products: ['view', 'create', 'review', 'edit'],
  'catalog.submission': ['view', 'review', 'request_changes', 'approve', 'reject'],
  'catalog.product': ['view', 'edit', 'publish', 'pause', 'unpublish'],
  'catalog.pricing': ['view_internal', 'edit'],
  'catalog.negotiation_rules': ['view_internal', 'edit'],
  'catalog.media': ['upload', 'review'],
  customers: ['view', 'edit'],
  financials: ['view', 'refund', 'reconcile'],
  refunds: ['view', 'manage'],
  deletions: ['view', 'manage'],
  reports: ['view'],
  ai_negotiation: ['view', 'manage', 'transcript.view'],
  app_releases: ['view', 'manage'],
  settings: ['view', 'manage'],
  audit: ['view'],
  'commerce.pod': ['review', 'override', 'eligibility'],
  'commerce.payments': ['view', 'reconcile'],
  'commerce.outbox': ['view', 'replay'],
  'commerce.settings': ['view', 'manage'],
  'delivery.coverage': ['view', 'manage'],
  'delivery.pricing': ['view', 'manage', 'preview'],
  fulfilment: ['view', 'manage', 'assign', 'consolidate'],
  'fulfilment.hub': ['view', 'receive', 'qc'],
  logistics: ['view', 'book', 'manage', 'track'],
  returns: ['view', 'review', 'manage'],
  custody: ['view', 'manage'],
  'finance.refunds': ['view', 'process'],
  'market.vendors': ['view', 'manage', 'invite'],
  'market.collections': ['view', 'manage'],
  'market.payments': ['view', 'reconcile'],
  'catalog.availability': ['view', 'manage', 'confirm'],
  coupons: ['view', 'manage'],
  credits: ['view', 'adjust'],
  waitlist: ['view', 'manage'],
  communications: ['send'],
  faq: ['view', 'manage'],
};

export const PLATFORM_PERMISSION_KEYS = Object.entries(domains)
  .flatMap(([domain, actions]) => actions.map((action) => `${domain}.${action}`));

/** Human-readable override for domains whose key no longer matches the display name. */
const domainLabels: Record<string, string> = {
  runners: 'market associates',
};

function domainLabel(domain: string) {
  return domainLabels[domain] || domain;
}

const readPermissions = PLATFORM_PERMISSION_KEYS.filter((key) => key.endsWith('.view') && key !== 'market.payments.view' && key !== 'app_releases.view');
const operationsPermissions = PLATFORM_PERMISSION_KEYS.filter((key) =>
  /^(states|cities|zones|markets|hubs|runners|partners|audit|delivery\.)/.test(key),
);
const orderRead = ['orders.view', 'customers.view', 'reports.view'];
const orderOperations = [...orderRead, 'orders.create', 'orders.edit', 'orders.cancel'];
const commerceOperations = [
  'commerce.pod.review', 'commerce.pod.eligibility', 'commerce.outbox.view',
  'fulfilment.view', 'fulfilment.manage', 'fulfilment.assign',
  'fulfilment.hub.view', 'fulfilment.hub.receive', 'fulfilment.hub.qc', 'fulfilment.consolidate',
  'logistics.view', 'logistics.book', 'logistics.manage', 'logistics.track',
  'returns.view', 'returns.review', 'custody.view', 'custody.manage',
];
const marketVendorOperations = [
  'market.vendors.view', 'market.vendors.manage', 'market.vendors.invite',
  'market.collections.view', 'market.collections.manage',
  'catalog.availability.view', 'catalog.availability.manage',
];
const catalogRead = [
  'products.view',
  'markets.view',
  'categories.view',
  'catalog.submission.view',
  'catalog.product.view',
];
const commercialManage = [
  ...catalogRead,
  'categories.manage',
  'catalog.product.edit',
  'catalog.product.publish',
  'catalog.product.pause',
  'catalog.product.unpublish',
  'catalog.pricing.view_internal',
  'catalog.pricing.edit',
  'catalog.negotiation_rules.view_internal',
  'catalog.negotiation_rules.edit',
  'catalog.media.review',
  'ai_negotiation.view', 'ai_negotiation.manage', 'ai_negotiation.transcript.view',
];
const supportPermissions = [
  ...orderRead,
  'customers.edit',
  'refunds.view',
  'deletions.view',
  'deletions.manage',
  'commerce.pod.review',
  'commerce.pod.eligibility',
];
const financePermissions = [
  'orders.view',
  'financials.view',
  'financials.refund',
  'financials.reconcile',
  'refunds.view',
  'refunds.manage',
  'reports.view',
  'audit.view',
  'commerce.payments.view',
  'commerce.payments.reconcile',
  'commerce.outbox.view', 'commerce.outbox.replay',
  'fulfilment.view', 'logistics.view', 'logistics.manage', 'returns.view', 'returns.review',
  'finance.refunds.view', 'finance.refunds.process',
  'coupons.view', 'coupons.manage', 'credits.view', 'credits.adjust',
  'waitlist.view', 'waitlist.manage',
];

const roles = [
  { key: 'SUPER_ADMIN', name: 'Super Admin', scope: ScopeType.GLOBAL, permissions: PLATFORM_PERMISSION_KEYS },
  { key: 'OPERATIONS_LEAD', name: 'Operations Lead', scope: ScopeType.MULTI_STATE, permissions: [...operationsPermissions, ...orderOperations, ...commerceOperations, ...marketVendorOperations, 'staff.view', 'communications.send'] },
  { key: 'STATE_OPERATIONS_MANAGER', name: 'State Operations Manager', scope: ScopeType.SINGLE_STATE, permissions: [...operationsPermissions, ...orderOperations, ...commerceOperations, ...marketVendorOperations] },
  {
    key: 'COMMERCIAL_MANAGER',
    name: 'Commercial Manager',
    scope: ScopeType.MULTI_STATE,
    // market.vendors.view lets this role see (and pick from) a Market's
    // vendor list when reassigning which vendor supplies a product.
    permissions: [...commercialManage, 'products.create', 'products.review', 'products.edit', 'catalog.availability.view', 'catalog.availability.manage', 'market.vendors.view', 'audit.view'],
  },
  {
    key: 'COMMERCIAL_OFFICER',
    name: 'Commercial Officer',
    scope: ScopeType.SINGLE_STATE,
    permissions: [...catalogRead, 'catalog.product.edit', 'catalog.pricing.view_internal', 'catalog.pricing.edit', 'catalog.availability.view', 'catalog.availability.manage'],
  },
  {
    key: 'CATALOG_REVIEWER',
    name: 'Catalog Reviewer',
    scope: ScopeType.MULTI_STATE,
    permissions: [
      ...catalogRead,
      'catalog.submission.review',
      'catalog.submission.request_changes',
      'catalog.submission.approve',
      'catalog.submission.reject',
      'products.create',
      'products.review',
      'catalog.media.review',
      'catalog.availability.view',
    ],
  },
  { key: 'DISPATCH_HUB_MANAGER', name: 'Dispatch Hub Manager', scope: ScopeType.HUB, permissions: ['hubs.view', 'markets.view', 'runners.view', 'runners.assign', ...orderOperations] },
  { key: 'DISPATCH_HUB_OFFICER', name: 'Dispatch Hub Officer', scope: ScopeType.HUB, permissions: ['hubs.view', 'markets.view', 'runners.view', 'orders.view', 'orders.edit'] },
  { key: 'LOGISTICS_OFFICER', name: 'Logistics Officer', scope: ScopeType.MULTI_STATE, permissions: ['hubs.view', 'markets.view', 'runners.view', 'orders.view', 'orders.edit', 'logistics.view', 'logistics.book', 'logistics.manage', 'logistics.track'] },
  { key: 'CUSTOMER_SUPPORT_OFFICER', name: 'Customer Support Officer', scope: ScopeType.MULTI_STATE, permissions: supportPermissions },
  { key: 'FINANCE_OFFICER', name: 'Finance Officer', scope: ScopeType.MULTI_STATE, permissions: [...financePermissions, 'market.payments.view', 'market.payments.reconcile'] },
  { key: 'MANAGEMENT_VIEWER', name: 'Management Viewer', scope: ScopeType.GLOBAL, permissions: [...readPermissions] },
];

export async function ensurePlatformAccessCatalog() {
  await Permission.bulkWrite(PLATFORM_PERMISSION_KEYS.map((key) => {
    const [domain, action] = key.split('.');
    return {
      updateOne: {
        filter: { key },
        update: {
          $set: { key, domain, description: `${action.replaceAll('_', ' ')} ${domainLabel(domain)}`, isActive: true },
        },
        upsert: true,
      },
    };
  }));
  await Role.bulkWrite(roles.map((role) => ({
    updateOne: {
      filter: { key: role.key },
      update: {
        ...(role.key === 'SUPER_ADMIN' ? {} : { $setOnInsert: { permissionKeys: role.permissions } }),
        $set: {
          key: role.key,
          name: role.name,
          description: `${role.name} platform role`,
          ...(role.key === 'SUPER_ADMIN' ? { permissionKeys: role.permissions } : {}),
          defaultScopeType: role.scope,
          // Only SUPER_ADMIN is a true system role that can never be edited
          // or deleted — every other seeded role is just a sensible default
          // an admin should be free to customize like any role they create.
          isSystem: role.key === 'SUPER_ADMIN',
          isActive: true,
        },
      },
      upsert: true,
    },
  })));
}
