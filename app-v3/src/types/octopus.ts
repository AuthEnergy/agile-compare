// Loose Octopus REST DTO fragments — only the fields the app reads, defensively
// typed (real responses omit documented fields, e.g. `gsp`).
import type { Agreement } from './domain';

export interface MeterRecord {
  serial_number?: string | null;
}

export interface MeterPoint {
  mpan?: string | null;
  gsp?: string | null;
  is_export?: boolean;
  meters?: MeterRecord[] | null;
  agreements?: Agreement[] | null;
}

export interface Property {
  postcode?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  address_line_3?: string | null;
  town?: string | null;
  electricity_meter_points?: MeterPoint[] | null;
}

export interface AccountData {
  number?: string;
  properties?: Property[] | null;
}

export interface RawConsumptionRow {
  interval_start: string;
  interval_end: string;
  consumption: number;
}

export interface ProductRow {
  code: string;
  display_name?: string | null;
  is_business?: boolean;
  is_prepay?: boolean;
  available_from?: string | null;
  available_to?: string | null;
}

export interface DiscoveredProduct {
  code: string;
  available_from: string | null;
  available_to: string | null;
}

export interface RawRateRow {
  valid_from: string;
  valid_to: string | null;
  value_inc_vat: number;
  payment_method?: string | null;
}

// A paginated REST list response.
export interface Page<T> {
  results?: T[] | null;
  next?: string | null;
}
