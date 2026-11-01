const { writeFileSync } = require('fs');
const { join } = require('path');

const apiPrefix = '/api/v1';

const tags = [
  ['System', 'Health checks and API metadata.'],
  ['Authentication', 'Customer/mobile authentication and profile endpoints.'],
  ['Public Marketplace', 'Public product, category, vendor, booth, feed, and search endpoints.'],
  ['Delivery Coverage', 'Customer delivery States and distance-aware delivery pricing.'],
  ['Customer Cart', 'Authenticated shopper cart management.'],
  ['Customer Orders', 'Authenticated checkout and order management.'],
  ['Negotiations', 'Customer AI negotiation sessions.'],
  ['Payments', 'Customer payment initialization, verification, and status checks.'],
  ['Notifications', 'Authenticated customer notifications.'],
  ['Devices', 'Authenticated customer device token registration for push notifications.'],
  ['Vendor Portal', 'Vendor profile, catalog, order, settlement, and bank detail endpoints.'],
  ['Logistics', 'Driver, field-agent, and admin assignment workflows.'],
  ['Uploads', 'Authenticated image uploads.'],
  ['Webhooks', 'Provider webhook receivers.'],
  ['Admin Auth', 'Admin-only authentication.'],
  ['Admin Dashboard', 'Admin dashboard, analytics, and health.'],
  ['Admin Users', 'Admin user and customer management.'],
  ['Admin Vendors', 'Admin vendor approval and configuration.'],
  ['Admin Products', 'Admin product catalog and review queue.'],
  ['Admin Orders', 'Admin order visibility and status overrides.'],
  ['Admin Dispatch', 'Admin delivery and driver operations.'],
  ['Admin Field Agents', 'Admin field-agent directory and toggles.'],
  ['Admin Booths', 'Admin physical booth provisioning and analytics.'],
  ['Admin Financials', 'Super-admin financial controls, settlements, and audit logs.'],
  ['Admin Negotiations', 'Admin AI negotiation monitoring.'],
  ['Admin Reports', 'Admin report listing and generation.'],
  ['Admin Settings', 'Admin platform settings.'],
  ['Admin Commerce', 'Vendor fulfilment, booth inventory, refunds, deletion, and checkout operations.'],
].map(([name, description]) => ({ name, description }));

const schemas = {
  ApiSuccess: {
    type: 'object',
    required: ['success', 'data', 'meta'],
    properties: {
      success: { type: 'boolean', example: true },
      data: { nullable: true },
      meta: {
        type: 'object',
        required: ['requestId', 'timestamp'],
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time' },
          pagination: { type: 'object', nullable: true },
        },
      },
    },
  },
  ApiError: {
    type: 'object',
    required: ['success', 'error', 'meta'],
    properties: {
      success: { type: 'boolean', example: false },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string', example: 'Invalid request body' },
          details: { nullable: true },
        },
      },
      meta: {
        type: 'object',
        required: ['requestId', 'timestamp'],
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', example: 'admin@gmail.com' },
      password: { type: 'string', example: '123456' },
    },
  },
  GoogleAuthRequest: {
    type: 'object',
    required: ['idToken'],
    properties: {
      idToken: {
        type: 'string',
        description: 'Google ID token returned by the iOS or Android Google OAuth client.',
      },
    },
  },
  AccountInvitationAcceptRequest: {
    type: 'object',
    required: ['token', 'password'],
    properties: {
      token: { type: 'string', minLength: 32, description: 'Single-use activation token delivered by email.' },
      password: { type: 'string', minLength: 9, maxLength: 128 },
    },
  },
  AuthLookupRequest: {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', format: 'email', example: 'shopper@example.com' } },
  },
  SignupStartRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', example: 'shopper@example.com' },
      password: { type: 'string', minLength: 6, example: '123456789' },
    },
  },
  SignupVerifyRequest: {
    type: 'object',
    required: ['signupSessionToken', 'code'],
    properties: {
      signupSessionToken: { type: 'string' },
      code: { type: 'string', example: '1234' },
    },
  },
  SignupCompleteRequest: {
    type: 'object',
    required: ['signupSessionToken', 'firstName', 'lastName'],
    properties: {
      signupSessionToken: { type: 'string' },
      firstName: { type: 'string', example: 'Hook' },
      lastName: { type: 'string', example: 'Shopper' },
      phone: { type: 'string', example: '+2348012345678' },
    },
  },
  RegisterRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', example: 'shopper@example.com' },
      password: { type: 'string', minLength: 6, example: '123456' },
    },
  },
  OtpRequest: {
    type: 'object',
    required: ['email', 'code'],
    properties: {
      email: { type: 'string', format: 'email', example: 'shopper@example.com' },
      code: { type: 'string', example: '1234' },
    },
  },
  RefreshRequest: {
    type: 'object',
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string' } },
  },
  ProfileRequest: {
    type: 'object',
    properties: {
      firstName: { type: 'string', example: 'Hook' },
      lastName: { type: 'string', example: 'Shopper' },
      phone: { type: 'string', example: '+2348012345678' },
      avatarUrl: { type: 'string', format: 'uri' },
      address: { type: 'object', additionalProperties: true },
      preferences: { type: 'object', additionalProperties: true },
    },
  },
  PasswordForgotRequest: {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', format: 'email' } },
  },
  PasswordResetRequest: {
    type: 'object',
    required: ['email', 'code', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', example: '1234' },
      password: { type: 'string', minLength: 6 },
    },
  },
  PasswordVerifyRequest: {
    type: 'object',
    required: ['email', 'code'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', example: '1234' },
    },
  },
  ChangePasswordRequest: {
    type: 'object',
    required: ['currentPassword', 'newPassword'],
    properties: {
      currentPassword: { type: 'string' },
      newPassword: { type: 'string', minLength: 6 },
    },
  },
  CartItemRequest: {
    type: 'object',
    required: ['productId', 'quantity'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, example: 2 },
      selectedVariants: {
        type: 'object',
        properties: {
          color: { type: 'string', example: 'Black' },
          size: { type: 'string', example: '42' },
        },
      },
      boothSessionToken: {
        type: 'string',
        description: 'Required when adding from booth inventory. The token is returned by code/QR resolution and binds the cart to one booth.',
      },
    },
  },
  QuantityRequest: {
    type: 'object',
    required: ['quantity'],
    properties: { quantity: { type: 'integer', minimum: 1, example: 1 } },
  },
  CheckoutRequest: {
    type: 'object',
    required: ['deliveryAddress'],
    properties: {
      guestEmail: { type: 'string', format: 'email', description: 'Required for guest checkout.' },
      guestName: { type: 'string', description: 'Required for guest checkout.' },
      deliveryAddress: {
        type: 'object',
        required: ['street', 'city', 'state', 'phone'],
        properties: {
          street: { type: 'string', example: '12 Admiralty Way' },
          city: { type: 'string', example: 'Lekki' },
          state: { type: 'string', example: 'Lagos' },
          landmark: { type: 'string', example: 'Near the roundabout' },
          phone: { type: 'string', example: '+2348012345678' },
          coordinates: {
            type: 'object',
            properties: {
              lat: { type: 'number', example: 6.4474 },
              lng: { type: 'number', example: 3.4542 },
            },
          },
        },
      },
      deliveryNotes: { type: 'string' },
      scheduledDeliveryAt: { type: 'string', format: 'date-time' },
      paymentMode: { type: 'string', enum: ['pay_now'], default: 'pay_now' },
      boothSessionToken: {
        type: 'string',
        description: 'Current booth session. Required for checkout when the cart belongs to a booth.',
      },
    },
  },
  BoothCodeRequest: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', pattern: '^\\d{6}$', example: '482913' } },
  },
  BoothSessionRequest: {
    type: 'object',
    required: ['boothSessionToken'],
    properties: { boothSessionToken: { type: 'string' } },
  },
  DeviceRegisterRequest: {
    type: 'object',
    required: ['expoPushToken'],
    properties: {
      expoPushToken: { type: 'string', example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' },
      platform: { type: 'string', enum: ['ios', 'android', 'web', 'unknown'], example: 'ios' },
      deviceName: { type: 'string', example: 'iPhone 17' },
    },
  },
  DeviceUnregisterRequest: {
    type: 'object',
    properties: {
      expoPushToken: { type: 'string' },
    },
  },
  NegotiationRequest: {
    type: 'object',
    required: ['productId', 'offeredPrice'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
      offeredPrice: { type: 'number', example: 45000 },
      message: { type: 'string', example: 'Can you do this price?' },
    },
  },
  NegotiationCounterRequest: {
    type: 'object',
    required: ['offeredPrice'],
    properties: {
      offeredPrice: { type: 'number', example: 47000 },
      message: { type: 'string' },
    },
  },
  PaymentInitializeRequest: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', example: 'ORD-2026-000001' },
    },
  },
  VendorRegistrationRequest: {
    type: 'object',
    required: ['businessName'],
    properties: {
      businessName: { type: 'string', example: 'Balogun Store Alpha' },
      businessEmail: { type: 'string', format: 'email' },
      businessPhone: { type: 'string' },
      businessAddress: { type: 'string' },
      description: { type: 'string' },
    },
  },
  ProductRequest: {
    type: 'object',
    required: ['title', 'costPrice', 'sellingPrice', 'minAcceptablePrice', 'categoryId'],
    properties: {
      title: { type: 'string', example: 'Nike Air Force 1' },
      description: { type: 'string' },
      costPrice: { type: 'number', example: 30000 },
      sellingPrice: { type: 'number', example: 45000 },
      discountedPrice: { type: 'number', example: 42000 },
      minAcceptablePrice: { type: 'number', example: 39000 },
      quantity: { type: 'integer', example: 10 },
      categoryId: { type: 'string', format: 'uuid' },
      images: { type: 'array', items: { type: 'string' } },
      colors: { type: 'array', items: { type: 'string' } },
      sizes: { type: 'array', items: { type: 'string' } },
    },
  },
  VendorBankRequest: {
    type: 'object',
    required: ['bankName', 'accountNumber', 'accountName', 'bankCode'],
    properties: {
      bankName: { type: 'string', example: 'GTBank' },
      accountNumber: { type: 'string', example: '0123456789' },
      accountName: { type: 'string', example: 'Balogun Store Alpha' },
      bankCode: { type: 'string', example: '058' },
    },
  },
  AssignDriverRequest: {
    type: 'object',
    required: ['orderId', 'driverId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
      driverId: { type: 'string', format: 'uuid' },
    },
  },
  DriverJobUpdateRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['assigned', 'driver_acknowledged', 'at_pickup', 'item_packed', 'qr_tagged', 'in_transit', 'delivered', 'failed'],
      },
      deliveryProof: { type: 'string' },
      trackingPath: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lat: { type: 'number' },
            lng: { type: 'number' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  },
  AdminUserRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      role: { type: 'string', enum: ['shopper', 'vendor', 'field_agent', 'ev_driver', 'admin', 'super_admin'] },
    },
  },
  RoleRequest: {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string', enum: ['shopper', 'vendor', 'field_agent', 'ev_driver', 'admin', 'super_admin'] } },
  },
  OrderStatusRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['awaiting_payment', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded'],
      },
    },
  },
  ProductReviewRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['draft', 'pending_approval', 'approved', 'rejected', 'disabled', 'sold_out'] },
      adjustedSellingPrice: { type: 'number' },
    },
  },
  VendorTierRequest: {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: ['tier_1', 'tier_2', 'tier_3'] },
      commissionPercentage: { type: 'number', minimum: 0, maximum: 100 },
    },
  },
  SettlementTriggerRequest: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      idempotencyKey: { type: 'string' },
    },
  },
  ReportRequest: {
    type: 'object',
    properties: { type: { type: 'string', example: 'sales' } },
  },
  BoothRequest: {
    type: 'object',
    required: ['name', 'location'],
    properties: {
      name: { type: 'string', example: 'Balogun Main Gate' },
      description: { type: 'string' },
      boothType: { type: 'string', enum: ['phygital', 'micro_hub'] },
      location: {
        type: 'object',
        required: ['address', 'lat', 'lng'],
        properties: {
          address: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
        },
      },
      fieldAgentId: { type: 'string', format: 'uuid' },
      previewImageUrl: { type: 'string' },
    },
  },
  BoothStatusRequest: {
    type: 'object',
    properties: { isActive: { type: 'boolean' } },
  },
};

function successResponse(description = 'Successful response') {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ApiSuccess' },
      },
    },
  };
}

function errorResponse(description) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ApiError' },
      },
    },
  };
}

function body(schemaRef, required = true) {
  return {
    required,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
      },
    },
  };
}

function param(name, description = `${name} value`) {
  return { name, in: 'path', required: true, schema: { type: 'string' }, description };
}

function query(name, schema = { type: 'string' }, description = `${name} filter`) {
  return { name, in: 'query', required: false, schema, description };
}

function boothSessionHeader(required = true) {
  return {
    name: 'X-Booth-Session',
    in: 'header',
    required,
    schema: { type: 'string' },
    description: 'Short-lived signed booth session returned after resolving a six-digit code or scanning a booth QR. It must match the cart booth for adding items and checkout.',
  };
}

function idempotencyHeader(required = true) {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required,
    schema: { type: 'string', minLength: 8, maxLength: 160 },
    description: 'Stable client command key. Repeating it returns the original result and cannot mutate a different resource.',
  };
}

function op(tag, summary, options = {}) {
  return {
    tags: [tag],
    summary,
    description: options.description || summary,
    security: options.public ? [] : [{ bearerAuth: [] }],
    parameters: options.parameters || [],
    requestBody: options.requestBody,
    responses: {
      200: successResponse(),
      201: successResponse('Created successfully'),
      400: errorResponse('Invalid request'),
      401: errorResponse('Authentication required or token invalid'),
      403: errorResponse('Permission denied'),
      404: errorResponse('Resource not found'),
    },
  };
}

const paths = {};

Object.assign(schemas, {
  MarketAssociateSubmissionRequest: {
    type: 'object',
    required: ['marketId', 'marketVendorId', 'categorySuggestionId', 'basicTitle', 'basePriceMinor', 'currency', 'availabilityStatus'],
    properties: {
      marketId: { type: 'string', example: 'MAR-2026-000001' },
      marketVendorId: { type: 'string', example: 'MVD-2026-000001' },
      categorySuggestionId: { type: 'string', example: 'CAT-2026-000001' },
      basicTitle: { type: 'string', maxLength: 180 },
      notes: { type: 'string', maxLength: 2000 },
      mediaIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
      basePriceMinor: { type: 'integer', minimum: 1, description: 'Observed Market price in kobo.' },
      currency: { type: 'string', enum: ['NGN'] },
      availabilityStatus: { type: 'string', enum: ['available', 'limited', 'unconfirmed'] },
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            size: { type: 'string' },
            colour: { type: 'string' },
            attributes: { type: 'object', additionalProperties: { type: 'string' } },
            active: { type: 'boolean' },
          },
        },
      },
      version: { type: 'integer', minimum: 1 },
    },
  },
  CatalogReviewDecision: {
    type: 'object',
    required: ['reason', 'version'],
    properties: {
      reason: { type: 'string', minLength: 5, maxLength: 1000 },
      fields: { type: 'array', items: { type: 'string' } },
      version: { type: 'integer', minimum: 1 },
    },
  },
  CatalogPricingRequest: {
    type: 'object',
    required: ['basePriceMinor', 'sellingPriceMinor', 'discountMinor', 'currency', 'reason', 'version'],
    properties: {
      basePriceMinor: { type: 'integer', minimum: 1 },
      sellingPriceMinor: { type: 'integer', minimum: 1 },
      discountMinor: { type: 'integer', minimum: 0 },
      currency: { type: 'string', enum: ['NGN'] },
      reason: { type: 'string', minLength: 5 },
      version: { type: 'integer', minimum: 1 },
    },
  },
  NegotiationCreateRequest: {
    type: 'object',
    required: ['productId', 'variantId', 'quantity'],
    properties: {
      productId: { type: 'string', example: 'PRD-2026-000001' },
      variantId: { type: 'string', example: 'VAR-2026-000001' },
      quantity: { type: 'integer', minimum: 1, maximum: 20 },
    },
  },
  NegotiationOfferRequest: {
    type: 'object',
    required: ['offeredPriceMinor'],
    properties: { offeredPriceMinor: { type: 'integer', minimum: 1 } },
  },
  MarketVendorRequest: {
    type: 'object',
    required: ['businessName', 'contactName', 'phone', 'preferredContactChannel', 'paymentProfile'],
    properties: {
      businessName: { type: 'string', maxLength: 180 },
      contactName: { type: 'string', maxLength: 120 },
      phone: { type: 'string' },
      email: { type: 'string', format: 'email' },
      address: { type: 'string', maxLength: 500 },
      preferredContactChannel: { type: 'string', enum: ['phone', 'email', 'whatsapp'] },
      paymentProfile: {
        type: 'object',
        required: ['method'],
        properties: {
          method: { type: 'string', enum: ['cash', 'bank_transfer', 'other'] },
          bankName: { type: 'string' },
          accountName: { type: 'string' },
          accountNumber: { type: 'string', writeOnly: true },
        },
      },
      notes: { type: 'string', maxLength: 1000 },
    },
  },
  VendorCollectionRequest: {
    type: 'object',
    required: ['quantity', 'actualCostMinor'],
    properties: {
      quantity: { type: 'integer', minimum: 1 },
      actualCostMinor: { type: 'integer', minimum: 0, description: 'Internal procurement cost in kobo.' },
      evidenceAssetIds: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      payment: {
        type: 'object',
        properties: {
          amountMinor: { type: 'integer', minimum: 0 },
          method: { type: 'string', enum: ['cash', 'bank_transfer', 'other'] },
          proofAssetIds: { type: 'array', items: { type: 'string' } },
          reference: { type: 'string' },
        },
      },
    },
  },
  AvailabilityConfirmRequest: {
    type: 'object',
    required: ['status', 'version'],
    properties: {
      status: { type: 'string', enum: ['available', 'limited'] },
      note: { type: 'string' },
      version: { type: 'integer', minimum: 1 },
    },
  },
  AvailabilityReportRequest: {
    type: 'object',
    required: ['note', 'version'],
    properties: {
      note: { type: 'string', minLength: 3 },
      version: { type: 'integer', minimum: 1 },
    },
  },
  VendorReconcileRequest: {
    type: 'object',
    required: ['status', 'reason'],
    properties: {
      status: { type: 'string', enum: ['reconciled', 'disputed'] },
      notes: { type: 'string' },
      reason: { type: 'string', minLength: 3 },
    },
  },
});
function add(method, path, operation) {
  paths[path] = paths[path] || {};
  paths[path][method] = operation;
}

// System
add('get', '/health', op('System', 'Check API health', { public: true }));

// Auth
add('post', `${apiPrefix}/auth/lookup`, op('Authentication', 'Lookup email and return next auth step', { public: true, requestBody: body('AuthLookupRequest') }));
add('post', `${apiPrefix}/auth/signup/start`, op('Authentication', 'Start staged signup and send email OTP', { public: true, requestBody: body('SignupStartRequest') }));
add('post', `${apiPrefix}/auth/signup/verify`, op('Authentication', 'Verify staged signup OTP', { public: true, requestBody: body('SignupVerifyRequest') }));
add('post', `${apiPrefix}/auth/signup/complete`, op('Authentication', 'Complete staged signup and issue tokens', { public: true, requestBody: body('SignupCompleteRequest') }));
add('post', `${apiPrefix}/auth/register`, op('Authentication', 'Register shopper account', { public: true, requestBody: body('RegisterRequest') }));
add('post', `${apiPrefix}/auth/login`, op('Authentication', 'Sign in a customer, staff, Market Associate, or Hook Partner account', { public: true, requestBody: body('LoginRequest') }));
add('post', `${apiPrefix}/auth/google`, op('Authentication', 'Login or create shopper account with a verified Google ID token', { public: true, requestBody: body('GoogleAuthRequest') }));
add('post', `${apiPrefix}/auth/invitations/accept`, op('Authentication', 'Activate an invited Staff, Market Associate, or Partner account and create its password', { public: true, requestBody: body('AccountInvitationAcceptRequest') }));
add('post', `${apiPrefix}/auth/verify-otp`, op('Authentication', 'Verify email OTP', { public: true, requestBody: body('OtpRequest') }));
add('post', `${apiPrefix}/auth/refresh`, op('Authentication', 'Refresh access token', { public: true, requestBody: body('RefreshRequest') }));
add('post', `${apiPrefix}/auth/password/forgot`, op('Authentication', 'Request password reset code', { public: true, requestBody: body('PasswordForgotRequest') }));
add('post', `${apiPrefix}/auth/password/verify`, op('Authentication', 'Verify password reset code', { public: true, requestBody: body('PasswordVerifyRequest') }));
add('post', `${apiPrefix}/auth/password/reset`, op('Authentication', 'Reset password with code', { public: true, requestBody: body('PasswordResetRequest') }));
add('get', `${apiPrefix}/auth/profile`, op('Authentication', 'Get current authenticated profile'));
add('patch', `${apiPrefix}/auth/profile`, op('Authentication', 'Update current authenticated profile', { requestBody: body('ProfileRequest') }));
add('post', `${apiPrefix}/auth/complete-profile`, op('Authentication', 'Complete shopper profile', { requestBody: body('ProfileRequest') }));
add('post', `${apiPrefix}/auth/password/change`, op('Authentication', 'Change authenticated user password', { requestBody: body('ChangePasswordRequest') }));

// Public marketplace
add('get', `${apiPrefix}/feed`, op('Public Marketplace', 'Get homepage feed', { public: true }));
add('get', `${apiPrefix}/products`, op('Public Marketplace', 'List approved products', { public: true, parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('q'), query('categoryId'), query('vendorId'), query('minPrice', { type: 'number' }), query('maxPrice', { type: 'number' })] }));
add('get', `${apiPrefix}/products/{id}`, op('Public Marketplace', 'Get product detail', { public: true, parameters: [param('id', 'Product id')] }));
add('get', `${apiPrefix}/categories`, op('Public Marketplace', 'List categories', { public: true }));
add('get', `${apiPrefix}/categories/tree`, op('Public Marketplace', 'List category tree', { public: true }));
add('get', `${apiPrefix}/categories/{id}`, op('Public Marketplace', 'Get category detail', { public: true, parameters: [param('id', 'Category id')] }));
add('get', `${apiPrefix}/vendors`, op('Public Marketplace', 'List approved vendors', { public: true, parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' })] }));
add('get', `${apiPrefix}/vendors/{id}`, op('Public Marketplace', 'Get vendor detail', { public: true, parameters: [param('id', 'Vendor id')] }));
add('get', `${apiPrefix}/booths`, op('Public Marketplace', 'List active booths', { public: true }));
add('get', `${apiPrefix}/booths/nearby`, op('Public Marketplace', 'List nearby booths', { public: true, parameters: [query('lat', { type: 'number' }), query('lng', { type: 'number' })] }));
add('get', `${apiPrefix}/booths/{id}`, op('Public Marketplace', 'Get booth detail', { public: true, parameters: [param('id', 'Booth id')] }));
add('get', `${apiPrefix}/search`, op('Public Marketplace', 'Search products and vendors', { public: true, parameters: [query('q')] }));
add('get', `${apiPrefix}/search/suggestions`, op('Public Marketplace', 'Get search suggestions', { public: true, parameters: [query('q')] }));

// Customer
add('get', `${apiPrefix}/cart`, op('Customer Cart', 'Get the authenticated customer cart.'));
add('post', `${apiPrefix}/cart/items`, op('Customer Cart', 'Add an authenticated customer cart item.', { requestBody: body('CartItemRequest') }));
add('patch', `${apiPrefix}/cart/items/{itemId}`, op('Customer Cart', 'Update cart item quantity.', { parameters: [param('itemId', 'Cart item id')], requestBody: body('QuantityRequest') }));
add('delete', `${apiPrefix}/cart/items/{itemId}`, op('Customer Cart', 'Remove a cart item.', { parameters: [param('itemId', 'Cart item id')] }));
add('delete', `${apiPrefix}/cart`, op('Customer Cart', 'Clear the authenticated customer cart.'));
add('get', `${apiPrefix}/commerce/config`, op('Customer Commerce', 'Get active policy versions and checkout capabilities.'));
add('get', `${apiPrefix}/orders`, op('Customer Orders', 'List authenticated customer orders.'));
add('get', `${apiPrefix}/orders/{id}`, op('Customer Orders', 'Get an owned customer order.', { parameters: [param('id', 'Order id')] }));
add('post', `${apiPrefix}/orders/{id}/cancel`, op('Customer Orders', 'Cancel an eligible owned order.', { parameters: [param('id', 'Order id')], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } } }));
add('post', `${apiPrefix}/payments/initialize`, op('Payments', 'Initialize the legacy customer payment flow from an immutable Order amount.', { requestBody: body('PaymentInitializeRequest') }));
add('post', `${apiPrefix}/payments/links`, op('Payments', 'Create an opaque 24-hour hosted payment link for an owned Order or fulfilment-group payment.'));
add('post', `${apiPrefix}/payments/links/{id}/revoke`, op('Payments', 'Revoke an owned hosted payment link.'));
add('get', `${apiPrefix}/public/payment-links/{token}`, op('Payments', 'Read a privacy-limited hosted payment summary.', { public: true }));
add('post', `${apiPrefix}/public/payment-links/{token}/initialize`, op('Payments', 'Initialize an enabled hosted payment provider using an idempotency key.', { public: true }));
add('get', `${apiPrefix}/public/payment-links/{token}/status`, op('Payments', 'Poll provider-verified hosted payment status.', { public: true }));
add('get', `${apiPrefix}/payments/{orderId}`, op('Payments', 'Poll safe payment status; this endpoint never confirms payment.', { parameters: [param('orderId', 'ORD public ID')] }));
add('get', `${apiPrefix}/payments/orders/{orderId}/status`, op('Payments', 'Compatibility alias for safe Order payment polling.', { parameters: [param('orderId', 'ORD public ID')] }));
add('post', `${apiPrefix}/orders/{id}/refunds`, op('Customer Orders', 'Request a support-reviewed refund against captured funds', { parameters: [param('id', 'Order id')] }));
add('post', `${apiPrefix}/support/account-deletion`, op('Authentication', 'Open a support-managed deletion request with a cooling-off period'));
add('post', `${apiPrefix}/analytics/checkout-events`, op('Payments', 'Record an authenticated non-sensitive checkout event.'));
add('get', `${apiPrefix}/notifications`, op('Notifications', 'List customer notifications.'));
add('patch', `${apiPrefix}/notifications/read-all`, op('Notifications', 'Mark all notifications as read.'));
add('delete', `${apiPrefix}/notifications/clear`, op('Notifications', 'Clear all notifications.'));
add('get', `${apiPrefix}/notifications/{id}`, op('Notifications', 'Get notification detail.', { parameters: [param('id', 'Notification id')] }));
add('patch', `${apiPrefix}/notifications/{id}/read`, op('Notifications', 'Mark notification as read.', { parameters: [param('id', 'Notification id')] }));
add('delete', `${apiPrefix}/notifications/{id}`, op('Notifications', 'Delete notification.', { parameters: [param('id', 'Notification id')] }));
add('post', `${apiPrefix}/devices/register`, op('Devices', 'Register an authenticated customer push token.', { requestBody: body('DeviceRegisterRequest') }));
add('post', `${apiPrefix}/devices/unregister`, op('Devices', 'Unregister an authenticated customer push token.', { requestBody: body('DeviceUnregisterRequest', false) }));

// Vendor
add('post', `${apiPrefix}/vendors/me/register`, op('Vendor Portal', 'Register current user as vendor', { requestBody: body('VendorRegistrationRequest') }));
add('get', `${apiPrefix}/vendors/me/profile`, op('Vendor Portal', 'Get current vendor profile'));
add('patch', `${apiPrefix}/vendors/me/profile`, op('Vendor Portal', 'Update current vendor profile', { requestBody: body('VendorRegistrationRequest', false) }));
add('get', `${apiPrefix}/vendors/me/products`, op('Vendor Portal', 'List current vendor products'));
add('post', `${apiPrefix}/vendors/me/products`, op('Vendor Portal', 'Create vendor product for review', { requestBody: body('ProductRequest') }));
add('patch', `${apiPrefix}/vendors/me/products/{id}`, op('Vendor Portal', 'Update vendor product and return to review', { parameters: [param('id', 'Product id')], requestBody: body('ProductRequest', false) }));
add('get', `${apiPrefix}/vendors/me/orders`, op('Vendor Portal', 'List current vendor orders'));
add('post', `${apiPrefix}/vendors/me/orders/{orderId}/fulfilment/{decision}`, op('Vendor Portal', 'Confirm or reject reserved stock for this vendor group', { parameters: [param('orderId', 'Order id'), param('decision', 'confirmed or rejected')] }));
add('get', `${apiPrefix}/vendors/me/settlements`, op('Vendor Portal', 'List current vendor settlements and summary'));
add('patch', `${apiPrefix}/vendors/me/bank-details`, op('Vendor Portal', 'Update current vendor bank details', { requestBody: body('VendorBankRequest') }));

// Logistics, uploads, webhooks
add('post', `${apiPrefix}/logistics/assign-driver`, op('Logistics', 'Assign driver to order', { requestBody: body('AssignDriverRequest') }));
add('get', `${apiPrefix}/logistics/driver/jobs`, op('Logistics', 'List driver jobs'));
add('patch', `${apiPrefix}/logistics/driver/jobs/{id}`, op('Logistics', 'Update driver job status/proof/location', { parameters: [param('id', 'Logistics job id')], requestBody: body('DriverJobUpdateRequest') }));
add('post', `${apiPrefix}/logistics/driver/jobs/{id}/verify-otp`, op('Logistics', 'Verify pickup OTP for driver job', { parameters: [param('id', 'Logistics job id')], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['otp'], properties: { otp: { type: 'string', example: '123456' } } } } } } }));
add('get', `${apiPrefix}/logistics/field-agent/profile`, op('Logistics', 'Get current field-agent profile'));
add('post', `${apiPrefix}/upload/image`, op('Uploads', 'Upload one image', { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary' } } } } } } }));
add('post', `${apiPrefix}/upload/images`, op('Uploads', 'Upload multiple images', { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['images'], properties: { images: { type: 'array', items: { type: 'string', format: 'binary' } } } } } } } }));
add('post', `${apiPrefix}/webhooks/paystack`, op('Webhooks', 'Receive a raw, signed Paystack event with replay and amount verification.', { public: true, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } }));
add('post', `${apiPrefix}/webhooks/opay`, op('Webhooks', 'Receive a raw, signed OPay event with replay and amount verification.', { public: true, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } }));
add('get', `${apiPrefix}/admin/commerce/payment-providers`, op('Admin Commerce', 'Read payment-provider enablement and credential readiness.'));
add('patch', `${apiPrefix}/admin/commerce/payment-providers`, op('Admin Commerce', 'Update enabled providers, display order, and default provider.'));

// Admin
add('get', `${apiPrefix}/admin/dashboard`, op('Admin Dashboard', 'Get admin dashboard summary'));
add('get', `${apiPrefix}/admin/analytics`, op('Admin Dashboard', 'Get admin analytics series'));
add('get', `${apiPrefix}/admin/health`, op('Admin Dashboard', 'Check admin API health'));
add('get', `${apiPrefix}/admin/operations/states`, op('Admin Settings', 'List Nigerian operating states', { parameters: [query('active', { type: 'boolean' })] }));
add('patch', `${apiPrefix}/admin/operations/states/{code}`, op('Admin Settings', 'Enable or disable an operating state (super-admin)', { parameters: [param('code', 'State code, for example LA')], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['isEnabled'], properties: { isEnabled: { type: 'boolean' } } } } } } }));
add('get', `${apiPrefix}/admin/users`, op('Admin Users', 'List users', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('role'), query('search')] }));
add('get', `${apiPrefix}/admin/customers`, op('Admin Users', 'List shopper customers', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('search')] }));
add('get', `${apiPrefix}/admin/users/{id}`, op('Admin Users', 'Get user detail', { parameters: [param('id', 'User id')] }));
add('post', `${apiPrefix}/admin/users`, op('Admin Users', 'Create user (super-admin)', { requestBody: body('AdminUserRequest') }));
add('patch', `${apiPrefix}/admin/users/{id}/toggle`, op('Admin Users', 'Toggle user active status', { parameters: [param('id', 'User id')] }));
add('patch', `${apiPrefix}/admin/users/{id}/role`, op('Admin Users', 'Change user role (super-admin)', { parameters: [param('id', 'User id')], requestBody: body('RoleRequest') }));
add('get', `${apiPrefix}/admin/vendors`, op('Admin Vendors', 'List vendors', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('approved', { type: 'boolean' }), query('stateCode')] }));
add('patch', `${apiPrefix}/admin/vendors/{id}/approve`, op('Admin Vendors', 'Approve vendor', { parameters: [param('id', 'Vendor id')] }));
add('patch', `${apiPrefix}/admin/vendors/{id}/reject`, op('Admin Vendors', 'Reject vendor', { parameters: [param('id', 'Vendor id')], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } } }));
add('patch', `${apiPrefix}/admin/vendors/{id}/tier`, op('Admin Vendors', 'Update vendor tier/commission (super-admin)', { parameters: [param('id', 'Vendor id')], requestBody: body('VendorTierRequest') }));
add('get', `${apiPrefix}/admin/products/review`, op('Admin Products', 'List product review queue', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' })] }));
add('get', `${apiPrefix}/admin/products`, op('Admin Products', 'List all products', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('status'), query('vendorId'), query('search')] }));
add('patch', `${apiPrefix}/admin/products/{id}/review`, op('Admin Products', 'Approve/reject product review', { parameters: [param('id', 'Product id')], requestBody: body('ProductReviewRequest') }));
add('get', `${apiPrefix}/admin/orders`, op('Admin Orders', 'List orders', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('status')] }));
add('get', `${apiPrefix}/admin/orders/{id}`, op('Admin Orders', 'Get order detail', { parameters: [param('id', 'Order id')] }));
add('patch', `${apiPrefix}/admin/orders/{id}/status`, op('Admin Orders', 'Update order status', { parameters: [param('id', 'Order id')], requestBody: body('OrderStatusRequest') }));
add('post', `${apiPrefix}/admin/orders/{orderId}/fulfilments/{vendorId}/{decision}`, op('Admin Commerce', 'Audited admin vendor-stock decision override', { parameters: [param('orderId', 'Order id'), param('vendorId', 'Vendor id'), param('decision', 'confirmed or rejected')] }));
add('get', `${apiPrefix}/admin/dispatch/active`, op('Admin Dispatch', 'List active deliveries'));
add('get', `${apiPrefix}/admin/dispatch`, op('Admin Dispatch', 'List delivery records', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' })] }));
add('get', `${apiPrefix}/admin/dispatch/drivers`, op('Admin Dispatch', 'List active drivers', { parameters: [query('stateCode')] }));
add('get', `${apiPrefix}/admin/market-associates`, op('Admin Market Associates', 'List market associates', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('stateCode')] }));
add('get', `${apiPrefix}/admin/market-associates/stats`, op('Admin Market Associates', 'Get market associate operational statistics'));
add('get', `${apiPrefix}/admin/market-associates/queue`, op('Admin Market Associates', 'List market associate catalog review queue'));
add('get', `${apiPrefix}/admin/market-associates/{id}`, op('Admin Market Associates', 'Get market associate detail', { parameters: [param('id', 'Market Associate id')] }));
add('patch', `${apiPrefix}/admin/market-associates/{id}/toggle`, op('Admin Market Associates', 'Toggle market associate active status', { parameters: [param('id', 'Market Associate id')] }));
add('patch', `${apiPrefix}/admin/market-associates/{id}/state`, op('Admin Market Associates', 'Assign market associate to an active operating state', { parameters: [param('id', 'Market Associate id')], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['stateCode'], properties: { stateCode: { type: 'string', example: 'LA' } } } } } } }));
add('get', `${apiPrefix}/admin/booths`, op('Admin Booths', 'List booths', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('stateCode')] }));
add('get', `${apiPrefix}/admin/booths/analytics`, op('Admin Booths', 'Get booth analytics'));
add('get', `${apiPrefix}/admin/booths/{id}`, op('Admin Booths', 'Get booth detail', { parameters: [param('id', 'Booth id')] }));
add('post', `${apiPrefix}/admin/booths`, op('Admin Booths', 'Provision booth (super-admin)', { requestBody: body('BoothRequest') }));
add('patch', `${apiPrefix}/admin/booths/{id}/status`, op('Admin Booths', 'Toggle booth status', { parameters: [param('id', 'Booth id')], requestBody: body('BoothStatusRequest', false) }));
add('post', `${apiPrefix}/admin/booths/{id}/qr/rotate`, op('Admin Commerce', 'Rotate and revoke the previous booth QR token (super-admin)', { parameters: [param('id', 'Booth id')] }));
add('post', `${apiPrefix}/admin/booths/{id}/code/rotate`, op('Admin Commerce', 'Rotate and reveal a new six-digit booth code once (super-admin)', { parameters: [param('id', 'Booth id')] }));
add('put', `${apiPrefix}/admin/booths/{id}/attendant`, op('Admin Commerce', 'Assign an existing attendant or create and assign a phone-enabled field agent', { parameters: [param('id', 'Booth id')] }));
add('delete', `${apiPrefix}/admin/booths/{id}/attendant`, op('Admin Commerce', 'Release the current booth attendant', { parameters: [param('id', 'Booth id')] }));
add('put', `${apiPrefix}/admin/booths/{id}/inventory`, op('Admin Commerce', 'Replace active booth product assignments', { parameters: [param('id', 'Booth id')] }));
add('get', `${apiPrefix}/admin/support/deletion-requests`, op('Admin Commerce', 'List support-managed account deletion requests'));
add('patch', `${apiPrefix}/admin/support/deletion-requests/{id}`, op('Admin Commerce', 'Verify, approve, cancel, or anonymize a deletion request', { parameters: [param('id', 'Deletion request id')] }));
add('get', `${apiPrefix}/admin/analytics/checkout`, op('Admin Commerce', 'Get checkout funnel analytics'));
add('get', `${apiPrefix}/admin/financials`, op('Admin Financials', 'Get financial dashboard (super-admin)'));
add('get', `${apiPrefix}/admin/financials/payments`, op('Admin Financials', 'List gateway payments and collection obligations'));
add('get', `${apiPrefix}/admin/financials/escrow-ledger`, op('Admin Financials', 'List immutable Hook escrow ledger entries'));
add('get', `${apiPrefix}/admin/financials/reconciliation`, op('Admin Financials', 'List provider reconciliation mismatches'));
add('post', `${apiPrefix}/admin/financials/payments/{paymentId}/refund`, op('Admin Financials', 'Issue an idempotent OPay refund (super-admin)', { parameters: [param('paymentId', 'Payment id')] }));
add('get', `${apiPrefix}/admin/financials/refund-requests`, op('Admin Financials', 'List support-reviewed customer refund requests'));
add('patch', `${apiPrefix}/admin/financials/refund-requests/{id}/review`, op('Admin Financials', 'Assign, review, or reject a refund request', { parameters: [param('id', 'Refund request id')] }));
add('post', `${apiPrefix}/admin/financials/refund-requests/{id}/approve`, op('Admin Financials', 'Approve and submit a provider refund (super-admin)', { parameters: [param('id', 'Refund request id')] }));
add('get', `${apiPrefix}/admin/financials/settlements`, op('Admin Financials', 'List settlements (super-admin)', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' }), query('status')] }));
add('post', `${apiPrefix}/admin/financials/settlements/trigger/{vendorId}`, op('Admin Financials', 'Trigger settlement payout stub (super-admin)', { parameters: [param('vendorId', 'Vendor id')], requestBody: body('SettlementTriggerRequest', false) }));
add('get', `${apiPrefix}/admin/financials/audit-logs`, op('Admin Financials', 'List financial audit logs (super-admin)'));
add('get', `${apiPrefix}/admin/negotiations`, op('Admin Negotiations', 'List AI negotiations', { parameters: [query('page', { type: 'integer' }), query('limit', { type: 'integer' })] }));
add('get', `${apiPrefix}/admin/negotiations/{id}`, op('Admin Negotiations', 'Get AI negotiation detail', { parameters: [param('id', 'Negotiation id')] }));
add('get', `${apiPrefix}/admin/reports`, op('Admin Reports', 'List generated reports'));
add('post', `${apiPrefix}/admin/reports/generate`, op('Admin Reports', 'Generate report metadata', { requestBody: body('ReportRequest', false) }));
add('get', `${apiPrefix}/admin/settings`, op('Admin Settings', 'Get platform settings'));
add('patch', `${apiPrefix}/admin/settings`, op('Admin Settings', 'Update platform settings (super-admin)', { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } }));
add('get', `${apiPrefix}/admin/delivery`, op('Delivery Coverage', 'View every Nigerian delivery State, pricing rule, and global delivery settings.'));
add('get', `${apiPrefix}/admin/delivery/settings`, op('Delivery Coverage', 'View delivery coverage and pricing settings.'));
add('patch', `${apiPrefix}/admin/delivery/settings`, op('Delivery Coverage', 'Update the global delivery fallback fee with an audit reason.'));
add('get', `${apiPrefix}/admin/delivery/rules`, op('Delivery Coverage', 'List active and inactive delivery pricing rules.'));
add('post', `${apiPrefix}/admin/delivery/rules`, op('Delivery Coverage', 'Create a State, Service Zone, or global flat/distance pricing rule.'));
add('patch', `${apiPrefix}/admin/delivery/rules/{id}`, op('Delivery Coverage', 'Update an audited delivery pricing rule.', { parameters: [param('id', 'DPR public ID')] }));
add('patch', `${apiPrefix}/admin/delivery/states/{id}`, op('Delivery Coverage', 'Enable or pause delivery in one Nigerian State.', { parameters: [param('id', 'STA public ID')] }));
add('post', `${apiPrefix}/admin/delivery/locations/refresh`, op('Delivery Coverage', 'Refresh the cached Nigerian State, capital, and Local Government catalog.', { requestBody: body('AuditReasonRequest', false) }));
add('post', `${apiPrefix}/admin/delivery/preview`, op('Delivery Coverage', 'Preview the effective delivery fee for a destination.'));

for (const resource of ['states', 'cities', 'zones', 'markets']) {
  add('get', `${apiPrefix}/public/${resource}`, op('Public Geography', `List active public ${resource}`));
  add('get', `${apiPrefix}/public/${resource}/{id}`, op('Public Geography', `Get active public ${resource.slice(0, -1)}`, {
    parameters: [param('id', 'Public Hook ID')],
  }));
}
add('get', `${apiPrefix}/public/states/{id}/lgas`, op('Public Geography', 'List active Local Government Areas for a delivery-enabled Nigerian State.', {
  public: true,
  parameters: [param('id', 'STA public ID')],
}));
const platformResources = [
  ['staff', 'Staff Accounts'], ['roles', 'Roles and Permissions'], ['permissions', 'Roles and Permissions'],
  ['states', 'Platform Geography'], ['cities', 'Platform Geography'], ['zones', 'Platform Geography'],
  ['markets', 'Operational Network'], ['hubs', 'Operational Network'], ['partners', 'Operational Network'],
  ['market-associates', 'Operational Network'], ['market-associate-assignments', 'Operational Network'],
  ['audit-logs', 'Platform Audit'],
];
for (const [resource, tag] of platformResources) {
  add('get', `${apiPrefix}/admin/${resource}`, op(tag, `List ${resource.replace(/-/g, ' ')}`));
  if (!['permissions', 'audit-logs'].includes(resource)) {
    add('post', `${apiPrefix}/admin/${resource}`, op(tag, `Create ${resource.replace(/-/g, ' ')}`));
  }
  add('get', `${apiPrefix}/admin/${resource}/{id}`, op(tag, `Get ${resource.replace(/-/g, ' ')} by public Hook ID`, {
    parameters: [param('id', 'Public Hook ID')],
  }));
}
add('get', `${apiPrefix}/admin/public-id-counters`, op('Platform Governance', 'Inspect annual public Hook ID counters'));
add('post', `${apiPrefix}/admin/public-id-counters/repair`, op('Platform Governance', 'Repair a public ID counter with mandatory reason and audit'));
for (const resource of ['staff', 'market-associates', 'partners']) {
  add('post', `${apiPrefix}/admin/${resource}/{id}/resend-invitation`, op('Platform Governance', `Revoke the previous token and resend a ${resource.slice(0, -1)} activation invitation`, {
    parameters: [param('id', 'Public Hook ID')],
  }));
}
add('get', `${apiPrefix}/market-associate/profile`, op('Market Associate Foundation', 'Get the authenticated Market Associate profile and scope'));
add('get', `${apiPrefix}/market-associate/markets`, op('Market Associate Foundation', 'List only Markets assigned to the authenticated Market Associate'));
add('get', `${apiPrefix}/market-associate/markets/{id}`, op('Market Supplier Operations', 'Get an assigned Market with suppliers, Products, submissions, and collections.', { parameters: [param('id', 'MAR public ID')] }));
add('get', `${apiPrefix}/market-associate/markets/{id}/vendors`, op('Market Supplier Operations', 'List suppliers in an assigned Market.', { parameters: [param('id', 'MAR public ID'), query('q')] }));
add('post', `${apiPrefix}/market-associate/markets/{id}/vendors`, op('Market Supplier Operations', 'Create a Market supplier and issue a single-use invitation.', { parameters: [param('id', 'MAR public ID')], requestBody: body('MarketVendorRequest') }));
add('get', `${apiPrefix}/market-associate/market-vendors/{id}`, op('Market Supplier Operations', 'Get one supplier within the Market Associate Market scope.', { parameters: [param('id', 'MVD public ID')] }));
add('patch', `${apiPrefix}/market-associate/market-vendors/{id}`, op('Market Supplier Operations', 'Update a supplier within the Market Associate Market scope.', { parameters: [param('id', 'MVD public ID')], requestBody: body('MarketVendorRequest', false) }));
add('post', `${apiPrefix}/market-associate/market-vendors/{id}/invite`, op('Market Supplier Operations', 'Revoke pending invitations and issue a new single-use supplier invitation.', { parameters: [param('id', 'MVD public ID')] }));
add('post', `${apiPrefix}/market-associate/product-submissions/{id}/collection`, op('Market Supplier Operations', 'Record collected quantity, procurement cost, and optional supplier payment.', { parameters: [param('id', 'SUB public ID')], requestBody: body('VendorCollectionRequest') }));
add('get', `${apiPrefix}/market-associate/vendor-collections`, op('Market Supplier Operations', 'List collections recorded by the authenticated Market Associate.', { parameters: [query('marketId')] }));
add('get', `${apiPrefix}/market-associate/availability-checks`, op('Catalog Availability', 'List source-owned or eligible fallback Market availability checks.'));
add('post', `${apiPrefix}/market-associate/products/{id}/availability/confirm`, op('Catalog Availability', 'Confirm available or limited supplier availability with optimistic versioning.', { parameters: [param('id', 'PRD public ID')], requestBody: body('AvailabilityConfirmRequest') }));
add('post', `${apiPrefix}/market-associate/products/{id}/availability/report`, op('Catalog Availability', 'Report a Product unavailable and keep it paused.', { parameters: [param('id', 'PRD public ID')], requestBody: body('AvailabilityReportRequest') }));
add('post', `${apiPrefix}/public/vendor-invitations/{token}/accept`, op('Market Supplier Operations', 'Accept a single-use supplier consent invitation without creating a login.', { public: true, parameters: [param('token', 'Single-use invitation token')] }));
add('get', `${apiPrefix}/partner/profile`, op('Partner Foundation', 'Get the authenticated Hook Partner profile'));
add('get', `${apiPrefix}/partner/location`, op('Partner Foundation', 'Get only the authenticated Hook Partner location'));

// Phase 3: Market Associate capture, Commercial Catalog, and deterministic negotiation.
add('get', `${apiPrefix}/market-associate/dashboard`, op('Market Associate Catalog Capture', 'Get self-scoped catalog capture metrics.'));
add('get', `${apiPrefix}/market-associate/product-submissions`, op('Market Associate Catalog Capture', 'List the authenticated Market Associate submissions with cursor pagination.'));
add('post', `${apiPrefix}/market-associate/product-submissions`, op('Market Associate Catalog Capture', 'Create a Market Associate product-submission draft.', { requestBody: body('MarketAssociateSubmissionRequest') }));
add('get', `${apiPrefix}/market-associate/product-submissions/{id}`, op('Market Associate Catalog Capture', 'Get one owned submission.', { parameters: [param('id', 'SUB public ID')] }));
add('patch', `${apiPrefix}/market-associate/product-submissions/{id}`, op('Market Associate Catalog Capture', 'Update an owned draft or requested-changes submission with optimistic versioning.', { parameters: [param('id', 'SUB public ID')], requestBody: body('MarketAssociateSubmissionRequest') }));
add('post', `${apiPrefix}/market-associate/product-submissions/{id}/submit`, op('Market Associate Catalog Capture', 'Submit a complete capture to Catalog Review.', { parameters: [param('id', 'SUB public ID')] }));
add('get', `${apiPrefix}/catalog/media/readiness`, op('Catalog Media', 'Check signed catalog media availability without exposing provider credentials.'));
add('post', `${apiPrefix}/catalog/media/upload-intents`, op('Catalog Media', 'Create a signed authenticated Cloudinary upload intent. Returns MEDIA_PROVIDER_UNAVAILABLE when signed uploads are disabled or not configured.'));
add('post', `${apiPrefix}/catalog/media/finalize`, op('Catalog Media', 'Verify provider metadata and finalize an owned catalog asset.'));

add('get', `${apiPrefix}/admin/catalog/review/dashboard`, op('Catalog Review', 'Get scoped review metrics.'));
add('get', `${apiPrefix}/admin/catalog/review`, op('Catalog Review', 'List scoped submission review queue.'));
add('get', `${apiPrefix}/admin/catalog/review/{id}`, op('Catalog Review', 'Get submission evidence and immutable Market Associate snapshot.', { parameters: [param('id', 'SUB public ID')] }));
add('post', `${apiPrefix}/admin/catalog/review/{id}/start`, op('Catalog Review', 'Claim and start a versioned review.', { parameters: [param('id', 'SUB public ID')] }));
for (const action of ['request-changes', 'approve', 'reject']) {
  add('post', `${apiPrefix}/admin/catalog/review/{id}/${action}`, op('Catalog Review', `${action.replace('-', ' ')} a submission with an audited reason.`, { parameters: [param('id', 'SUB public ID')], requestBody: body('CatalogReviewDecision') }));
}
add('get', `${apiPrefix}/admin/commercial/dashboard`, op('Commercial Catalog', 'Get scoped Commercial Catalog metrics.'));
add('get', `${apiPrefix}/admin/commercial/products`, op('Commercial Catalog', 'List Commercial Product drafts and published products.'));
add('get', `${apiPrefix}/admin/commercial/products/{id}`, op('Commercial Catalog', 'Get internal Commercial Product workspace.', { parameters: [param('id', 'PRD public ID')] }));
add('get', `${apiPrefix}/admin/commercial/products/{id}/preview`, op('Commercial Catalog', 'Get the safe customer-facing preview without internal pricing fields.', { parameters: [param('id', 'PRD public ID')] }));
add('patch', `${apiPrefix}/admin/commercial/products/{id}/pricing`, op('Commercial Catalog', 'Set integer minor-unit pricing; margins are derived by the backend.', { parameters: [param('id', 'PRD public ID')], requestBody: body('CatalogPricingRequest') }));
for (const action of ['publish', 'pause', 'availability-unconfirmed', 'unpublish']) {
  add('post', `${apiPrefix}/admin/commercial/products/{id}/${action}`, op('Commercial Catalog', `${action.replaceAll('-', ' ')} a Commercial Product through the audited lifecycle.`, { parameters: [param('id', 'PRD public ID')] }));
}
add('get', `${apiPrefix}/admin/markets/{id}/vendors`, op('Market Supplier Operations', 'List Market suppliers in the authenticated Staff State scope.', { parameters: [param('id', 'MAR public ID')] }));
add('get', `${apiPrefix}/admin/market-vendors/{id}`, op('Market Supplier Operations', 'Get a masked supplier operations record.', { parameters: [param('id', 'MVD public ID')] }));
add('patch', `${apiPrefix}/admin/market-vendors/{id}`, op('Market Supplier Operations', 'Update a supplier with an audited reason.', { parameters: [param('id', 'MVD public ID')], requestBody: body('MarketVendorRequest', false) }));
add('get', `${apiPrefix}/admin/market-vendors/{id}/payment-details`, op('Market Supplier Finance', 'View decrypted supplier bank details. Finance or Super Admin only; requires an audit reason.', { parameters: [param('id', 'MVD public ID'), query('reason')] }));
add('get', `${apiPrefix}/admin/vendor-collections`, op('Market Supplier Operations', 'List State-scoped supplier collections.', { parameters: [query('marketId'), query('vendorId'), query('marketAssociateId'), query('status')] }));
add('post', `${apiPrefix}/admin/vendor-collections/{id}/reconcile`, op('Market Supplier Finance', 'Reconcile or dispute a supplier payment with an audited reason.', { parameters: [param('id', 'VCL public ID')], requestBody: body('VendorReconcileRequest') }));
add('get', `${apiPrefix}/admin/settings/catalog-availability`, op('Catalog Availability', 'Get the universal availability-check window and overdue count.'));
add('patch', `${apiPrefix}/admin/settings/catalog-availability`, op('Catalog Availability', 'Update the universal availability-check window with an audited reason.'));
add('get', `${apiPrefix}/public/home`, op('Public Catalog', 'Get safe published catalog foundations for Home.', { public: true }));
add('get', `${apiPrefix}/public/categories`, op('Public Catalog', 'List safe active categories.', { public: true }));
add('get', `${apiPrefix}/public/products`, op('Public Catalog', 'List safe published products using cursor pagination.', { public: true, parameters: [query('cursor'), query('limit', { type: 'integer' }), query('stateId'), query('marketId'), query('categoryId'), query('q')] }));
add('get', `${apiPrefix}/public/products/{id}`, op('Public Catalog', 'Get one safe published product by PRD ID or slug.', { public: true, parameters: [param('id', 'PRD public ID or slug')] }));
add('get', `${apiPrefix}/public/search`, op('Public Catalog', 'Search only safe published catalog fields.', { public: true, parameters: [query('q'), query('cursor'), query('limit', { type: 'integer' })] }));
add('post', `${apiPrefix}/negotiations`, op('AI Negotiation', 'Start a deterministic three-offer product negotiation.', { requestBody: body('NegotiationCreateRequest') }));
add('post', `${apiPrefix}/negotiations/{id}/offers`, op('AI Negotiation', 'Submit one integer minor-unit offer. Requires Idempotency-Key.', { parameters: [param('id', 'NEG public ID')], requestBody: body('NegotiationOfferRequest') }));
add('get', `${apiPrefix}/negotiations/{id}`, op('AI Negotiation', 'Get an owned negotiation session.', { parameters: [param('id', 'NEG public ID')] }));
add('post', `${apiPrefix}/negotiations/{id}/accept`, op('AI Negotiation', 'Accept the current deterministic counter and create one 30-minute verified-customer quote.', { parameters: [param('id', 'NEG public ID')] }));
add('post', `${apiPrefix}/negotiations/{id}/close`, op('AI Negotiation', 'Close an owned active negotiation.', { parameters: [param('id', 'NEG public ID')] }));

// Phase 4: State-grouped customer and Partner commerce with Paystack evidence.
for (const method of ['get', 'post']) add(method, `${apiPrefix}/addresses`, op('Customer Commerce', `${method === 'get' ? 'List' : 'Create'} customer-owned delivery addresses.`));
for (const method of ['patch', 'delete']) add(method, `${apiPrefix}/addresses/{id}`, op('Customer Commerce', `${method === 'patch' ? 'Update' : 'Archive'} an owned address.`, { parameters: [param('id', 'ADR public ID')] }));
add('post', `${apiPrefix}/addresses/{id}/default`, op('Customer Commerce', 'Set the customer default address.', { parameters: [param('id', 'ADR public ID')] }));
add('post', `${apiPrefix}/commerce/import`, op('Customer Commerce', 'Idempotently import a device-local cart and saved products after authentication.'));
add('post', `${apiPrefix}/checkout/preview`, op('Customer Commerce', 'Create one checkout preview for the complete customer cart.'));
add('post', `${apiPrefix}/checkout/confirm`, op('Customer Commerce', 'Confirm one combined customer order. Requires Idempotency-Key.'));
add('post', `${apiPrefix}/payments/initialize`, op('Payments', 'Initialize the legacy hosted checkout from an owned ORD public ID.'));
add('get', `${apiPrefix}/payments/{id}`, op('Payments', 'Poll safe payment and Order status; this never confirms payment.', { parameters: [param('id', 'PAY or ORD public ID')] }));
add('post', `${apiPrefix}/webhooks/paystack`, op('Payments', 'Raw-body Paystack webhook with HMAC evidence validation.', { public: true }));
add('post', `${apiPrefix}/webhooks/opay`, op('Payments', 'Raw-body OPay webhook with signed evidence validation.', { public: true }));
add('get', `${apiPrefix}/payments/paystack/callback`, op('Payments', 'Paystack browser return bridge. Redirects to the Hook app and never confirms payment.', { public: true }));
add('get', `${apiPrefix}/partner/customers/lookup`, op('Partner Commerce', 'Exact customer lookup in the authenticated Partner scope.'));
add('post', `${apiPrefix}/partner/customers`, op('Partner Commerce', 'Create an attested assisted-ordering customer without verifying email.'));
add('get', `${apiPrefix}/partner/commerce/config`, op('Partner Commerce', 'Get active policy versions required for assisted customer attestation.'));
add('get', `${apiPrefix}/partner/customers/{customerId}/cart`, op('Partner Commerce', 'Get the assisted basket for an attested customer.', { parameters: [param('customerId', 'CUS public ID')] }));
add('post', `${apiPrefix}/partner/customers/{customerId}/cart/items`, op('Partner Commerce', 'Add a backend-priced line to an assisted basket.', { parameters: [param('customerId', 'CUS public ID')] }));
add('patch', `${apiPrefix}/partner/customers/{customerId}/cart/items/{itemId}`, op('Partner Commerce', 'Update an assisted basket line.', { parameters: [param('customerId', 'CUS public ID'), param('itemId', 'CTI public ID')] }));
add('delete', `${apiPrefix}/partner/customers/{customerId}/cart/items/{itemId}`, op('Partner Commerce', 'Remove an assisted basket line.', { parameters: [param('customerId', 'CUS public ID'), param('itemId', 'CTI public ID')] }));
add('post', `${apiPrefix}/partner/customers/{customerId}/checkout/states/{stateId}/preview`, op('Partner Commerce', 'Preview a prepaid assisted checkout for home delivery or initiating-Partner pickup.', { parameters: [param('customerId', 'CUS public ID'), param('stateId', 'STA public ID')] }));
add('post', `${apiPrefix}/partner/customers/{customerId}/checkout/states/{stateId}/confirm`, op('Partner Commerce', 'Confirm an idempotent prepaid assisted Order.', { parameters: [param('customerId', 'CUS public ID'), param('stateId', 'STA public ID')] }));
add('get', `${apiPrefix}/partner/orders`, op('Partner Commerce', 'List only Orders initiated by the authenticated Partner.'));
add('post', `${apiPrefix}/partner/orders/{orderId}/payment-instructions`, op('Partner Commerce', 'Initialize customer Paystack payment instructions for an owned Partner Order.', { parameters: [param('orderId', 'ORD public ID')] }));
add('get', `${apiPrefix}/admin/commerce/payments`, op('Commerce Operations', 'List scoped canonical payments.'));
add('get', `${apiPrefix}/admin/commerce/integration-exceptions`, op('Commerce Operations', 'List unresolved Paystack evidence exceptions.'));
add('get', `${apiPrefix}/admin/commerce/outbox`, op('Commerce Operations', 'Inspect fulfilment-ready outbox events.'));
add('get', `${apiPrefix}/admin/commerce/settings`, op('Commerce Operations', 'Get Super Admin commerce defaults.'));
add('patch', `${apiPrefix}/admin/commerce/settings`, op('Commerce Operations', 'Update audited Super Admin commerce defaults.'));

// Phase 5: Market Associate fulfilment, Hub custody, logistics, Partner collection, returns, and refunds.
add('get', `${apiPrefix}/market-associate/fulfilments/dashboard`, op('Market Associate Fulfilment', 'Get self-scoped fulfilment metrics and SLA work.'));
add('get', `${apiPrefix}/market-associate/fulfilments`, op('Market Associate Fulfilment', 'List fulfilment tasks assigned to the authenticated Market Associate.', { parameters: [query('status'), query('limit', { type: 'integer' })] }));
add('get', `${apiPrefix}/market-associate/fulfilments/{id}`, op('Market Associate Fulfilment', 'Get one assigned fulfilment task and its customer-safe item details.', { parameters: [param('id', 'FUL public ID')] }));
for (const action of ['accept', 'start_sourcing', 'secure', 'begin_packing', 'pack']) {
  add('post', `${apiPrefix}/market-associate/fulfilments/{id}/${action}`, op('Market Associate Fulfilment', `Market Associate ${action.replaceAll('_', ' ')} action with optimistic versioning.`, { parameters: [param('id', 'FUL public ID')] }));
}
add('post', `${apiPrefix}/market-associate/fulfilments/{id}/issues`, op('Market Associate Fulfilment', 'Report a sourcing or fulfilment exception.', { parameters: [param('id', 'FUL public ID'), idempotencyHeader(false)] }));
add('get', `${apiPrefix}/admin/fulfilment/control-tower`, op('Fulfilment Operations', 'View State/Hub-scoped fulfilment tasks, exceptions, shipments, and returns.'));
add('get', `${apiPrefix}/admin/fulfilment/tasks/{id}`, op('Fulfilment Operations', 'Get a State/Hub-scoped fulfilment task, order summary, and assigned item snapshots.', { parameters: [param('id', 'FUL public ID')] }));
add('get', `${apiPrefix}/admin/fulfilment/market-associates`, op('Fulfilment Operations', 'List active compatible Market Associate profiles for audited reassignment.', { parameters: [query('stateId'), query('limit', { type: 'integer' })] }));
add('get', `${apiPrefix}/admin/fulfilment/hubs`, op('Fulfilment Operations', 'List active compatible Dispatch Hubs for audited reassignment.', { parameters: [query('stateId'), query('limit', { type: 'integer' })] }));
add('post', `${apiPrefix}/admin/fulfilment/tasks/{id}/reassign`, op('Fulfilment Operations', 'Reassign a task only to a compatible active Market Associate and Hub with an audited reason.', { parameters: [param('id', 'FUL public ID')] }));
add('get', `${apiPrefix}/admin/fulfilment/exceptions`, op('Fulfilment Operations', 'List open State/Hub-scoped fulfilment exceptions.', { parameters: [query('stateId'), query('hubId')] }));
add('patch', `${apiPrefix}/admin/fulfilment/exceptions/{id}`, op('Fulfilment Operations', 'Move an exception to in-progress, resolved, or dismissed with an audited reason.', { parameters: [param('id', 'EXC public ID')] }));
add('get', `${apiPrefix}/admin/fulfilment/hub`, op('Hub Operations', 'View inbound Market Associate packages, Hub packages, exceptions, and consolidations.'));
add('get', `${apiPrefix}/admin/fulfilment/consolidations`, op('Hub Operations', 'List State/Hub-scoped consolidation records.', { parameters: [query('status'), query('stateId'), query('hubId'), query('limit', { type: 'integer' })] }));
add('post', `${apiPrefix}/admin/fulfilment/packages/{id}/receive`, op('Hub Operations', 'Receive a Market Associate package after validating its one-time scan credential.', { parameters: [param('id', 'RPK public ID'), idempotencyHeader()] }));
add('post', `${apiPrefix}/admin/fulfilment/packages/{id}/qc`, op('Hub Operations', 'Record a visible quality-check result with optimistic versioning.', { parameters: [param('id', 'HPK public ID')] }));
add('post', `${apiPrefix}/admin/fulfilment/orders/{id}/consolidate`, op('Hub Operations', 'Create a single complete State Order consolidation; incomplete orders are rejected.', { parameters: [param('id', 'ORD public ID')] }));
add('post', `${apiPrefix}/admin/fulfilment/consolidations/{id}/seal`, op('Hub Operations', 'Seal one complete customer parcel for dispatch.', { parameters: [param('id', 'CON public ID')] }));
add('get', `${apiPrefix}/admin/fulfilment/shipments`, op('Fulfilment Logistics', 'List State/Hub-scoped shipment records.'));
add('get', `${apiPrefix}/admin/fulfilment/logistics/readiness`, op('Fulfilment Logistics', 'Inspect manual, development simulator, and external provider readiness without exposing credentials.'));
add('post', `${apiPrefix}/admin/fulfilment/orders/{id}/shipments`, op('Fulfilment Logistics', 'Book one sealed parcel through manual logistics fallback, the development-only simulator, or an enabled provider.', { parameters: [param('id', 'ORD public ID'), idempotencyHeader()] }));
add('patch', `${apiPrefix}/admin/fulfilment/shipments/{id}`, op('Fulfilment Logistics', 'Advance a shipment through the explicit status map.', { parameters: [param('id', 'SHP public ID')] }));
add('post', `${apiPrefix}/webhooks/logistics/{provider}`, op('Fulfilment Logistics', 'Receive an authenticated deduplicated provider tracking event.', { public: true, parameters: [param('provider', 'Logistics provider'), { name: 'x-provider-event-id', in: 'header', required: true, schema: { type: 'string' } }, { name: 'x-provider-signature', in: 'header', required: true, schema: { type: 'string' } }] }));
add('get', `${apiPrefix}/partner/fulfilment/custody`, op('Partner Custody', 'List only packages assigned to the authenticated initiating Hook Partner.'));
add('get', `${apiPrefix}/partner/fulfilment/custody/{orderId}`, op('Partner Custody', 'Get one Partner custody record without exposing the collection-code hash.', { parameters: [param('orderId', 'ORD public ID')] }));
add('post', `${apiPrefix}/partner/fulfilment/custody/{id}/receive`, op('Partner Custody', 'Receive one package into the authenticated Partner location.', { parameters: [param('id', 'PCU public ID'), idempotencyHeader(false)] }));
add('post', `${apiPrefix}/partner/fulfilment/custody/{id}/release`, op('Partner Custody', 'Release a package only after verified payment and a valid one-time collection code.', { parameters: [param('id', 'PCU public ID'), idempotencyHeader(false)] }));
add('get', `${apiPrefix}/orders/{id}/fulfilment`, op('Customer Fulfilment', 'Return customer-safe Market Associate, Hub, shipment, Partner custody, return, and refund progress.', { parameters: [param('id', 'ORD public ID')] }));
add('post', `${apiPrefix}/orders/{id}/returns`, op('Returns and Refunds', 'Create an eligible customer return issue within the delivery/collection window.', { parameters: [param('id', 'ORD public ID')] }));
add('get', `${apiPrefix}/admin/fulfilment/returns`, op('Returns and Refunds', 'List State-scoped customer return requests.'));
add('patch', `${apiPrefix}/admin/fulfilment/returns/{id}/review`, op('Returns and Refunds', 'Approve or reject a return with a mandatory reason.', { parameters: [param('id', 'RET public ID')] }));
add('get', `${apiPrefix}/admin/fulfilment/refunds`, op('Returns and Refunds', 'List State-scoped refund records.'));
add('post', `${apiPrefix}/admin/fulfilment/refunds`, op('Returns and Refunds', 'Create an idempotent refund request within the captured balance.', { parameters: [idempotencyHeader()] }));
add('post', `${apiPrefix}/admin/fulfilment/refunds/{id}/process`, op('Returns and Refunds', 'Process a refund through the active payment provider.', { parameters: [param('id', 'RFD public ID'), idempotencyHeader(false)] }));

const obsoletePrefixes = [
  `${apiPrefix}/vendors`,
  `${apiPrefix}/booths`,
  `${apiPrefix}/logistics`,
  `${apiPrefix}/admin/vendors`,
  `${apiPrefix}/admin/booths`,
  `${apiPrefix}/admin/dispatch`,
];
const obsoletePaths = new Set([
  `${apiPrefix}/admin/orders/{orderId}/fulfilments/{vendorId}/{decision}`,
  `${apiPrefix}/admin/financials/settlements`,
  `${apiPrefix}/admin/financials/settlements/trigger/{vendorId}`,
]);
for (const path of Object.keys(paths)) {
  if (obsoletePaths.has(path) || obsoletePrefixes.some((prefix) => path.startsWith(prefix))) {
    delete paths[path];
  }
}

const inactiveTags = new Set([
  'Vendor Portal',
  'Logistics',
  'Admin Vendors',
  'Admin Dispatch',
  'Admin Field Agents',
  'Admin Booths',
]);

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Hook API',
    version: '1.0.0',
    description: 'Hook Phase 5 platform API. State-grouped commerce, Paystack evidence, fulfilment operations, Hub custody, logistics boundaries, returns, and refunds use public Hook IDs and the standard { success, data, meta } contract.',
  },
  servers: [
    { url: 'http://localhost:4000', description: 'Local development server' },
    { url: 'https://hook-api.onrender.com', description: 'Production server' },
  ],
  tags: tags.filter((tag) => !inactiveTags.has(tag.name)).concat([
    { name: 'Admin Market Associates', description: 'Admin Market Associate identity, scope, and assignment controls.' },
    { name: 'Public Geography', description: 'Safe public State, City, Zone, and Market configuration.' },
    { name: 'Staff Accounts', description: 'Staff identity, role, scope, and session controls.' },
    { name: 'Roles and Permissions', description: 'Live RBAC configuration.' },
    { name: 'Platform Geography', description: 'State, City, and Service Zone administration.' },
    { name: 'Operational Network', description: 'Market, Dispatch Hub, Hook Partner, and Market Associate administration.' },
    { name: 'Platform Audit', description: 'Append-only sanitized operational audit events.' },
    { name: 'Platform Governance', description: 'Super-admin platform counter governance.' },
    { name: 'Market Associate Foundation', description: 'Self-scoped Market Associate account foundation.' },
    { name: 'Partner Foundation', description: 'Self-scoped Hook Partner account foundation.' },
    { name: 'Market Associate Catalog Capture', description: 'Self-scoped Market Associate Market catalog capture and submission workflow.' },
    { name: 'Market Supplier Operations', description: 'Market-scoped supplier invitations, sourcing collections, and masked operational records.' },
    { name: 'Market Supplier Finance', description: 'Finance-restricted supplier payment reconciliation and audited bank-detail access.' },
    { name: 'Catalog Availability', description: 'Universal Product availability checks, Market Associate confirmation, and overdue escalation.' },
    { name: 'Catalog Media', description: 'Signed private catalog media upload and verification.' },
    { name: 'Catalog Review', description: 'Scoped submission review and approval workflow.' },
    { name: 'Commercial Catalog', description: 'Commercial content, pricing, negotiation rules, and publication lifecycle.' },
    { name: 'Public Catalog', description: 'Safe customer-facing published categories and products.' },
    { name: 'AI Negotiation', description: 'Deterministic three-offer negotiation; Azure OpenAI controls wording only.' },
    { name: 'Customer Commerce', description: 'Customer addresses, State-grouped baskets, and backend-controlled checkout.' },
    { name: 'Payments', description: 'Provider-neutral payment lifecycle with active Paystack Hosted Checkout.' },
    { name: 'Partner Commerce', description: 'Self-scoped prepaid assisted ordering through Hook Partners.' },
    { name: 'Commerce Operations', description: 'Payment evidence, settings, and outbox operations.' },
    { name: 'Market Associate Fulfilment', description: 'Self-scoped Market Associate sourcing, packing, and issue workflows.' },
    { name: 'Fulfilment Operations', description: 'State/Hub-scoped fulfilment control and reassignment.' },
    { name: 'Hub Operations', description: 'Market Associate package receipt, visible QC, consolidation, and sealing.' },
    { name: 'Fulfilment Logistics', description: 'Shipment booking, explicit transitions, and provider webhooks.' },
    { name: 'Partner Custody', description: 'Initiating Partner package custody and customer collection.' },
    { name: 'Customer Fulfilment', description: 'Customer-safe post-order fulfilment progress.' },
    { name: 'Returns and Refunds', description: 'Return review and provider-backed refund operations.' },
  ]),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas,
  },
};

writeFileSync(join(__dirname, '..', 'swagger-spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Swagger spec generated with ${Object.keys(paths).length} paths.`);
