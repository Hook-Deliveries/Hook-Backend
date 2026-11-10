import { z } from 'zod';

const publicId = z.string().trim().min(3).max(80);

const paymentProfile = z.object({
  method: z.enum(['cash', 'bank_transfer', 'other']),
  bankName: z.string().trim().max(120).optional(),
  bankCode: z.string().trim().max(30).optional(),
  accountName: z.string().trim().max(180).optional(),
  accountNumber: z.string().trim().regex(/^\d{6,20}$/).optional(),
}).strict();

export const marketVendorSchema = z.object({
  businessName: z.string().trim().min(2).max(180),
  contactName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().email().optional(),
  address: z.string().trim().max(500).optional(),
  preferredContactChannel: z.enum(['phone', 'email', 'whatsapp']).default('phone'),
  paymentProfile,
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const marketVendorUpdateSchema = marketVendorSchema.partial().extend({
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();

export const vendorCollectionSchema = z.object({
  quantity: z.coerce.number().int().positive().max(100000),
  actualCostMinor: z.coerce.number().int().positive().max(100_000_000_000),
  evidenceAssetIds: z.array(publicId).max(12).default([]),
  notes: z.string().trim().max(1000).optional(),
  payment: z.object({
    amountMinor: z.coerce.number().int().positive().max(100_000_000_000),
    method: z.enum(['cash', 'bank_transfer', 'other']),
    proofAssetIds: z.array(publicId).max(12).default([]),
    reference: z.string().trim().max(180).optional(),
    notes: z.string().trim().max(1000).optional(),
  }).optional(),
}).strict();

export const vendorReconcileSchema = z.object({
  status: z.enum(['reconciled', 'disputed']),
  notes: z.string().trim().max(1000).optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const availabilityConfirmSchema = z.object({
  status: z.enum(['available', 'limited']),
  note: z.string().trim().max(500).optional(),
  version: z.coerce.number().int().positive(),
}).strict();

export const availabilityBulkConfirmSchema = z.object({
  items: z.array(z.object({
    publicId: z.string().trim().min(1),
    version: z.coerce.number().int().positive(),
  }).strict()).min(1).max(100),
  status: z.enum(['available', 'limited']).default('available'),
}).strict();

export const availabilityReportSchema = z.object({
  note: z.string().trim().min(3).max(500),
  version: z.coerce.number().int().positive(),
}).strict();
