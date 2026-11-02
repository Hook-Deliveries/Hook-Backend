// Shared interfaces used across modules

export interface JwtPayload {
  sub: string; // user_id
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest {
  user: JwtPayload;
  [key: string]: unknown;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data?: T;
  errors?: string[];
  timestamp: string;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface DateRangeFilter {
  from?: Date;
  to?: Date;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface AddressInfo {
  street: string;
  city: string;
  state: string;
  country: string;
  zip?: string;
  coordinates?: GeoPoint;
  landmark?: string;
  phone?: string;
}

export interface Money {
  amount: number;
  currency: 'NGN';
}

export interface SplitPaymentDetail {
  hookShare: number;
  vendorShare: number;
  deliveryFee: number;
  commission: number;
  negotiationAdjustment: number;
  gatewayFee: number;
}

export interface WebhookPayload<T> {
  event: string;
  data: T;
  sentAt: string;
}
