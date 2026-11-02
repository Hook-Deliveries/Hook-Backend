import { Router } from 'express';
import { z } from 'zod';
import { PlatformController } from '@controllers/admin/platform.controller';
import { requirePermission } from '@middleware/permissions';
import { validateBody } from '@middleware/validate';
import { asyncHandler } from '@utils/http';
import { requireSuperAdmin } from '@middleware/roles';
import { AdminMarketVendorController } from '@controllers/market-vendor.controller';
import { marketVendorSchema, marketVendorUpdateSchema, vendorReconcileSchema } from '@validations/vendor.schemas';

const idList = z.array(z.string().min(1)).default([]);
const reason = z.string().trim().min(3).max(500).optional();
const status = z.enum(['active', 'inactive']).optional();
const coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional();
const lifecycleSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const stateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  capitalName: z.string().trim().min(2).max(100).optional(),
  code: z.string().trim().length(2),
  status,
  timezone: z.string().default('Africa/Lagos'),
  currency: z.string().length(3).default('NGN'),
  deliveryPromiseHours: z.number().int().positive().default(24),
  operationsEnabled: z.boolean().default(false),
  configuration: z.record(z.string(), z.unknown()).optional(),
  reason,
});
const citySchema = z.object({
  stateId: z.string().min(1),
  name: z.string().trim().min(2).max(100),
  code: z.string().trim().min(2).max(12),
  status,
  defaultHubId: z.string().optional(),
  reason,
});
const marketSchema = z.object({
  name: z.string().trim().min(2).max(150),
  stateId: z.string().min(1),
  cityId: z.string().min(1),
  zoneId: z.string().optional(),
  hubId: z.string().optional(),
  address: z.string().trim().min(5).max(500),
  imageUrl: z.string().url().optional(),
  shortDisplayName: z.string().trim().min(2).max(60).optional(),
  discoveryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a six-digit hex colour').optional(),
  isFeatured: z.boolean().default(false),
  displayPriority: z.number().int().min(0).max(10000).default(100),
  coordinates,
  operatingHours: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(1000).optional(),
  status,
  reason,
});
const hubSchema = z.object({
  name: z.string().trim().min(2).max(150),
  stateId: z.string().min(1),
  cityId: z.string().min(1),
  zoneIds: idList,
  address: z.string().trim().min(5).max(500),
  coordinates,
  capacity: z.record(z.string(), z.unknown()).optional(),
  operatingHours: z.record(z.string(), z.unknown()).optional(),
  cutoffRules: z.record(z.string(), z.unknown()).optional(),
  contact: z.record(z.string(), z.unknown()).optional(),
  marketIds: idList,
  staffIds: idList,
  status,
  reason,
});
const person = {
  email: z.string().email(),
  phone: z.string().trim().min(7).max(30),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  password: z.string().min(9).max(128).optional(),
};
const staffSchema = z.object({
  ...person,
  roleIds: z.array(z.string().min(1)).min(1),
  scopeType: z.enum(['global', 'multi_state', 'single_state', 'hub']),
  stateIds: idList,
  hubIds: idList,
});
const staffUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  roleIds: idList.optional(),
  scopeType: z.enum(['global', 'multi_state', 'single_state', 'hub']).optional(),
  stateIds: idList.optional(),
  hubIds: idList.optional(),
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
const partnerSchema = z.object({
  ...person,
  name: z.string().trim().min(2).max(150),
  stateId: z.string().min(1),
  cityId: z.string().min(1),
  zoneId: z.string().optional(),
  marketId: z.string().optional(),
  address: z.string().trim().min(5).max(500),
  coordinates,
  contact: z.record(z.string(), z.unknown()),
  devicePolicy: z.record(z.string(), z.unknown()).optional(),
  reason,
});
const deleteAccountSchema = z.object({ reason, confirmation: z.string().min(3).max(80) }).strict();
const marketAssociateSchema = z.object({
  ...person,
  stateIds: z.array(z.string().min(1)).min(1),
  hubIds: idList,
  /** Markets to assign as soon as the account exists; the first becomes the primary Market. */
  marketIds: z.array(z.string().min(1)).max(10).optional(),
  availability: z.enum(['available', 'unavailable', 'paused']).optional(),
  reason,
});
const assignmentSchema = z.object({
  marketAssociateId: z.string().min(1),
  marketId: z.string().min(1),
  preferredHubId: z.string().optional(),
  priority: z.number().int().positive().default(100),
  isPrimary: z.boolean().default(false),
  activeFrom: z.coerce.date(),
  activeTo: z.coerce.date().optional(),
  assignmentReason: z.string().trim().min(3).max(500),
});

/**
 * Builds the PATCH schema from the create schema.
 *
 * `.partial()` alone is not enough: fields declared with `.default([])` still
 * inject that default when the client omits them, so a PATCH that never
 * mentions `marketIds` arrived at the controller carrying `marketIds: []` and
 * silently wiped the hub's market links. Defaults are right for POST (a new
 * record with no links) and wrong for PATCH, so they are stripped here.
 *
 * An explicitly sent `[]` still comes through, so clearing links on purpose
 * keeps working.
 */
function patchSchema(schema: z.ZodObject<any>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, value]) => {
      const inner = (value as any)?._def?.innerType;
      return [key, inner ? inner.optional() : value];
    }),
  );
  return z.object(shape).partial();
}

function crud(
  router: Router,
  path: string,
  handlers: {
    list: any; create: any; detail: any; update: any; status?: any;
  },
  schema: z.ZodObject<any>,
) {
  router.get(path, asyncHandler(handlers.list));
  router.post(path, validateBody(schema), asyncHandler(handlers.create));
  router.get(`${path}/:id`, asyncHandler(handlers.detail));
  router.patch(`${path}/:id`, validateBody(patchSchema(schema)), asyncHandler(handlers.update));
  if (handlers.status) {
    router.post(`${path}/:id/activate`, validateBody(lifecycleSchema), asyncHandler(handlers.status));
    router.post(`${path}/:id/deactivate`, validateBody(lifecycleSchema), asyncHandler(handlers.status));
  }
}

export function createPlatformAdminRouter() {
  const router = Router();
  const controller = new PlatformController();
  const marketVendors = new AdminMarketVendorController();

  router.get('/permissions', asyncHandler(controller.permissions));
  router.get('/roles', asyncHandler(controller.roles));
  router.post('/roles', validateBody(z.object({
    key: z.string().min(3), name: z.string().min(2), description: z.string().default(''),
    permissionKeys: idList, defaultScopeType: z.enum(['global', 'multi_state', 'single_state', 'hub', 'self']),
    isActive: z.boolean().default(true),
  })), asyncHandler(controller.createRole));
  router.get('/roles/:id', asyncHandler(controller.roleDetail));
  router.patch('/roles/:id', validateBody(z.object({
    key: z.string().min(3).optional(),
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    permissionKeys: idList.optional(),
    defaultScopeType: z.enum(['global', 'multi_state', 'single_state', 'hub', 'self']).optional(),
    isActive: z.boolean().optional(),
    reason,
  }).strict()), asyncHandler(controller.updateRole));
  router.delete('/roles/:id', validateBody(lifecycleSchema), asyncHandler(controller.archiveRole));

  router.get('/staff', asyncHandler(controller.listStaff));
  router.post('/staff', validateBody(staffSchema), asyncHandler(controller.createStaff));
  router.get('/staff/:id', asyncHandler(controller.staffDetail));
  router.patch('/staff/:id', validateBody(staffUpdateSchema), asyncHandler(controller.updateStaff));
  router.post('/staff/:id/suspend', validateBody(lifecycleSchema), asyncHandler(controller.staffStatus));
  router.post('/staff/:id/reactivate', validateBody(lifecycleSchema), asyncHandler(controller.staffStatus));
  router.post('/staff/:id/restore', validateBody(lifecycleSchema), asyncHandler(controller.staffStatus));
  router.post('/staff/:id/archive', validateBody(lifecycleSchema), asyncHandler(controller.archiveStaff));
  router.post('/staff/:id/revoke-sessions', validateBody(lifecycleSchema), asyncHandler(controller.revokeStaffSessions));
  router.delete('/staff/:id', requireSuperAdmin, validateBody(deleteAccountSchema), asyncHandler(controller.deleteStaff));
  router.post('/staff/:id/resend-invitation', asyncHandler(controller.resendStaffInvitation));
  router.post('/staff/:id/cancel-invitation', validateBody(lifecycleSchema), asyncHandler(controller.cancelStaffInvitation));

  crud(router, '/states', {
    list: controller.listStates, create: controller.createState, detail: controller.stateDetail,
    update: controller.updateState, status: controller.stateStatus,
  }, stateSchema);
  crud(router, '/cities', {
    list: controller.listCities, create: controller.createCity, detail: controller.cityDetail,
    update: controller.updateCity, status: controller.cityStatus,
  }, citySchema);
  crud(router, '/markets', {
    list: controller.listMarkets, create: controller.createMarket, detail: controller.marketDetail,
    update: controller.updateMarket, status: controller.marketStatus,
  }, marketSchema);
  // Global vendor directory. The per-Market list below still works; this is
  // the entry point for the admin Vendors page.
  router.get('/market-vendors', requirePermission('market.vendors.view'), asyncHandler(marketVendors.directory));
  router.post('/markets/:id/vendors', requirePermission('market.vendors.manage'), validateBody(marketVendorSchema), asyncHandler(marketVendors.create));
  router.post('/market-vendors/:id/invite', requirePermission('market.vendors.invite'), asyncHandler(marketVendors.invite));
  router.get('/markets/:id/vendors', requirePermission('market.vendors.view'), asyncHandler(marketVendors.vendors));
  router.get('/market-vendors/:id', requirePermission('market.vendors.view'), asyncHandler(marketVendors.detail));
  router.get('/market-vendors/:id/payment-details', requirePermission('market.payments.view'), asyncHandler(marketVendors.paymentDetails));
  router.patch('/market-vendors/:id', requirePermission('market.vendors.manage'), validateBody(marketVendorUpdateSchema), asyncHandler(marketVendors.update));
  router.get('/vendor-collections', requirePermission('market.collections.view'), asyncHandler(marketVendors.collections));
  router.post('/vendor-collections/:id/reconcile', requirePermission('market.payments.reconcile'), validateBody(vendorReconcileSchema), asyncHandler(marketVendors.reconcile));
  router.post('/markets/:id/assign-hub', validateBody(z.object({ hubId: z.string().min(1), reason: z.string().min(3) })), asyncHandler(controller.assignMarketHub));
  crud(router, '/hubs', {
    list: controller.listHubs, create: controller.createHub, detail: controller.hubDetail,
    update: controller.updateHub, status: controller.hubStatus,
  }, hubSchema);
  router.post('/hubs/:id/assign-markets', validateBody(z.object({ marketIds: z.array(z.string()).min(1), reason: z.string().min(3) })), asyncHandler(controller.assignHubMarkets));

  router.get('/partners', asyncHandler(controller.listPartners));
  router.post('/partners', validateBody(partnerSchema), asyncHandler(controller.createPartner));
  router.get('/partners/:id', asyncHandler(controller.partnerDetail));
  router.patch('/partners/:id', validateBody(partnerSchema.partial()), asyncHandler(controller.updatePartner));
  router.post('/partners/:id/activate', validateBody(lifecycleSchema), asyncHandler(controller.partnerStatus));
  router.post('/partners/:id/suspend', validateBody(lifecycleSchema), asyncHandler(controller.partnerStatus));
  router.post('/partners/:id/reactivate', validateBody(lifecycleSchema), asyncHandler(controller.partnerStatus));
  router.post('/partners/:id/resend-invitation', asyncHandler(controller.resendPartnerInvitation));
  router.post('/partners/:id/cancel-invitation', validateBody(lifecycleSchema), asyncHandler(controller.cancelPartnerInvitation));
  router.post('/partners/:id/archive', validateBody(lifecycleSchema), asyncHandler(controller.archivePartner));
  router.post('/partners/:id/restore', validateBody(lifecycleSchema), asyncHandler(controller.restorePartner));
  router.post('/partners/:id/revoke-sessions', validateBody(lifecycleSchema), asyncHandler(controller.revokePartnerSessions));
  router.delete('/partners/:id', requireSuperAdmin, validateBody(deleteAccountSchema), asyncHandler(controller.deletePartner));
  router.get('/partners/:id/analytics', asyncHandler(controller.partnerAnalytics));

  router.get('/market-associates', asyncHandler(controller.listMarketAssociates));
  router.post('/market-associates', validateBody(marketAssociateSchema), asyncHandler(controller.createMarketAssociate));
  router.get('/market-associates/:id', asyncHandler(controller.marketAssociateDetail));
  router.patch('/market-associates/:id', validateBody(marketAssociateSchema.partial()), asyncHandler(controller.updateMarketAssociate));
  router.post('/market-associates/:id/activate', validateBody(lifecycleSchema), asyncHandler(controller.marketAssociateStatus));
  router.post('/market-associates/:id/suspend', validateBody(lifecycleSchema), asyncHandler(controller.marketAssociateStatus));
  router.post('/market-associates/:id/reactivate', validateBody(lifecycleSchema), asyncHandler(controller.marketAssociateStatus));
  router.post('/market-associates/:id/archive', validateBody(lifecycleSchema), asyncHandler(controller.archiveMarketAssociate));
  router.post('/market-associates/:id/restore', validateBody(lifecycleSchema), asyncHandler(controller.restoreMarketAssociate));
  router.post('/market-associates/:id/revoke-sessions', validateBody(lifecycleSchema), asyncHandler(controller.revokeMarketAssociateSessions));
  router.delete('/market-associates/:id', requireSuperAdmin, validateBody(deleteAccountSchema), asyncHandler(controller.deleteMarketAssociate));
  router.post('/market-associates/:id/resend-invitation', asyncHandler(controller.resendMarketAssociateInvitation));
  router.post('/market-associates/:id/cancel-invitation', validateBody(lifecycleSchema), asyncHandler(controller.cancelMarketAssociateInvitation));

  router.get('/market-associate-assignments', asyncHandler(controller.listAssignments));
  router.post('/market-associate-assignments', validateBody(assignmentSchema), asyncHandler(controller.createAssignment));
  router.get('/market-associate-assignments/:id', asyncHandler(controller.assignmentDetail));
  router.patch('/market-associate-assignments/:id', validateBody(assignmentSchema.partial()), asyncHandler(controller.updateAssignment));
  router.post('/market-associate-assignments/:id/activate', validateBody(lifecycleSchema), asyncHandler(controller.assignmentStatus));
  router.post('/market-associate-assignments/:id/pause', validateBody(lifecycleSchema), asyncHandler(controller.assignmentStatus));
  router.post('/market-associate-assignments/:id/end', validateBody(lifecycleSchema), asyncHandler(controller.assignmentStatus));

  router.get('/audit-logs', asyncHandler(controller.auditLogs));
  router.get('/audit-logs/facets', asyncHandler(controller.auditFacets));
  router.get('/audit-logs/:id', asyncHandler(controller.auditDetail));
  router.get('/public-id-counters', asyncHandler(controller.counters));
  router.post('/public-id-counters/repair', validateBody(z.object({
    domain: z.enum([
      'state', 'city', 'zone', 'market', 'hub', 'partner', 'marketAssociate', 'customer', 'staff', 'audit',
      'category', 'submission', 'product', 'variant', 'negotiation', 'quote',
      'marketVendor', 'vendorInvitation', 'vendorCollection', 'vendorPayment',
    ]),
    year: z.number().int().min(2020).optional(), sequence: z.number().int().nonnegative(), reason: z.string().min(5),
  })), asyncHandler(controller.repairCounter));

  return router;
}
