// Service Tickets utility functions for grouping and aggregating billable time entries

export interface ServiceTicket {
  id: string; // Composite key: date-customerId-userId-location
  date: string;
  customerId: string;
  customerName: string;
  location?: string; // Work location - different locations create separate tickets
  customerInfo: {
    name: string;
    contact_name?: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    zip_code?: string;
    country?: string;
    tax_id?: string;
    po_number?: string;
    approver_name?: string;
    approver?: string;
    po_afe?: string;
    cc?: string;
    location_code?: string;
    service_location?: string;
  };
  userId: string;
  userName: string;
  userInitials: string;
  userEmail?: string;
  projectId?: string;
  projectName?: string;
  projectNumber?: string;
  // Project-level service ticket defaults
  projectLocation?: string;
  projectApproverPoAfe?: string;
  projectApprover?: string;
  projectPoAfe?: string;
  projectCc?: string;
  projectOther?: string;
  // Entry-level overrides (from time entry form - take priority over project/customer defaults)
  entryLocation?: string;
  entryApprover?: string;
  entryPoAfe?: string;
  entryCc?: string;
  entryOther?: string;
  ticketNumber?: string; // Format: {initials}_{YY}{sequence} e.g., "DB_25001"
  totalHours: number;
  entries: TimeEntryWithRelations[];
  hoursByRateType: {
    'Shop Time': number;
    'Shop Overtime': number;
    'Travel Time': number;
    'Field Time': number;
    'Field Overtime': number;
  };
  // Employee-specific billable rates
  rates: {
    rt: number; // Regular Time / Shop Time rate
    tt: number; // Travel Time rate
    ft: number; // Field Time rate
    shop_ot: number; // Shop Overtime rate
    field_ot: number; // Field Overtime rate
  };
}

export interface TimeEntryWithRelations {
  id: string;
  date: string;
  hours: number;
  updated_at?: string;
  description?: string;
  rate_type?: string;
  start_time?: string;
  end_time?: string;
  location?: string; // Work location for grouping into service tickets
  approver?: string;
  po_afe?: string; // PO/AFE entered on the time entry
  cc?: string;
  other?: string;
  is_demo?: boolean;
  user?: {
    id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };
  project?: {
    id: string;
    name: string;
    project_number?: string;
    // Project-specific rate overrides (per Junior/Senior employee status)
    shop_junior_rate?: number;
    shop_senior_rate?: number;
    ft_junior_rate?: number;
    ft_senior_rate?: number;
    travel_rate?: number;
    // Service ticket defaults
    location?: string;
    approver?: string;
    po_afe?: string;
    cc?: string;
    other?: string;
    customer?: {
      id: string;
      name: string;
      contact_name?: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      state?: string;
      zip_code?: string;
      country?: string;
      tax_id?: string;
      po_number?: string;
      approver_name?: string;
      location_code?: string;
      service_location?: string;
      // Customer special billing rates (fallback when project has no rate override)
      rate_shop_junior?: number;
      rate_shop_senior?: number;
      rate_field_junior?: number;
      rate_field_senior?: number;
      rate_travel?: number;
    };
  };
  user_id: string;
  project_id?: string;
}

// Employee type for rate lookup
export interface EmployeeWithRates {
  id: string;
  user_id: string;
  department?: string;
  position?: string; // 'Junior' or 'Senior' - used for project rate overrides
  rt_rate?: number;
  tt_rate?: number;
  ft_rate?: number;
  shop_ot_rate?: number;
  field_ot_rate?: number;
}

// Default rates if employee doesn't have custom rates
const DEFAULT_RATES = {
  rt: 110,
  tt: 85,
  ft: 140,
  shop_ot: 165,
  field_ot: 165,
};

/**
 * Groups billable time entries into service tickets
 * One ticket per (date, customer, employee) combination
 * @param entries - Time entries to group
 * @param employees - Optional employee data for rate lookup
 */
export function groupEntriesIntoTickets(
  entries: TimeEntryWithRelations[],
  employees?: EmployeeWithRates[]
): ServiceTicket[] {
  const ticketMap = new Map<string, ServiceTicket>();
  
  // Create a map of user_id to employee rates for quick lookup
  const employeeRatesMap = new Map<string, { rt: number; tt: number; ft: number; shop_ot: number; field_ot: number }>();
  const employeeDepartmentMap = new Map<string, string>();
  const employeePositionMap = new Map<string, string>();
  if (employees) {
    for (const emp of employees) {
      employeeRatesMap.set(emp.user_id, {
        rt: emp.rt_rate ?? DEFAULT_RATES.rt,
        tt: emp.tt_rate ?? DEFAULT_RATES.tt,
        ft: emp.ft_rate ?? DEFAULT_RATES.ft,
        shop_ot: emp.shop_ot_rate ?? DEFAULT_RATES.shop_ot,
        field_ot: emp.field_ot_rate ?? DEFAULT_RATES.field_ot,
      });
      if (emp.department) {
        employeeDepartmentMap.set(emp.user_id, emp.department);
      }
      if (emp.position) {
        employeePositionMap.set(emp.user_id, emp.position);
      }
    }
  }

  for (const entry of entries) {
    // Skip entries from Panel Shop employees - they don't create service tickets
    const employeeDepartment = employeeDepartmentMap.get(entry.user_id);
    if (employeeDepartment === 'Panel Shop') {
      continue;
    }
    
    // Skip entries without a project or customer - these are internal time, not billable service tickets
    if (!entry.project || !entry.project.customer) {
      continue;
    }

    // Skip IONEX Systems (internal) - do not create service tickets for internal hours
    const customerName = entry.project.customer.name;
    if (customerName && customerName.trim().toLowerCase() === 'ionex systems') {
      continue;
    }
    
    // Get customer info from project (entry.project and entry.project.customer are guaranteed to exist here)
    const customerId = entry.project.customer.id;
    const customerInfo: ServiceTicket['customerInfo'] = {
      name: entry.project.customer.name,
      contact_name: entry.project.customer.contact_name,
      email: entry.project.customer.email,
      phone: entry.project.customer.phone,
      address: entry.project.customer.address,
      city: entry.project.customer.city,
      state: entry.project.customer.state,
      zip_code: entry.project.customer.zip_code,
      country: entry.project.customer.country,
      tax_id: entry.project.customer.tax_id,
      po_number: entry.project.customer.po_number,
      approver_name: entry.project.customer.approver_name,
      location_code: entry.project.customer.location_code,
      service_location: entry.project.customer.service_location,
    };

    const date = entry.date;
    const userId = entry.user_id;
    // Use entry location, or fall back to project location, or empty string
    const entryLocation = entry.location || entry.project?.location || '';

    // Only PO/AFE/CC (Cost Center) creates new tickets - different approver, Coding, or Location do NOT
    const poAfe = entry.po_afe ?? entry.project?.po_afe ?? '';
    const groupingKey = buildGroupingKey(poAfe);

    // Create composite key - hierarchy: Project > PO/AFE/CC (Cost Center). Location is editable, not a grouping dimension.
    const projectId = entry.project?.id ?? '';
    const ticketKey = `${date}-${customerId}-${userId}-${projectId}-${groupingKey}`;

    // Get or create ticket
    let ticket = ticketMap.get(ticketKey);
    if (!ticket) {
      // Generate user initials from first and last name
      const firstName = entry.user?.first_name || '';
      const lastName = entry.user?.last_name || '';
      const initials = (firstName.charAt(0) + lastName.charAt(0)).toUpperCase() || 'XX';
      
      // Get employee-specific rates or use defaults
      let employeeRates = employeeRatesMap.get(userId) || { ...DEFAULT_RATES };
      
      // Check for project-specific rate overrides
      // These override employee rates based on Junior/Senior status
      if (entry.project) {
        const employeePosition = employeePositionMap.get(userId) || 'Junior'; // Default to Junior if not specified
        const isSenior = employeePosition.toLowerCase() === 'senior';
        
        // Apply project rates if they exist; fall back to customer special billing rates
        const project = entry.project;
        const customer = project.customer;
        const projectRates = { ...employeeRates };
        
        if (isSenior) {
          // Senior: project.shop_senior_rate ?? customer.rate_shop_senior
          const shopSenior = project.shop_senior_rate ?? customer?.rate_shop_senior;
          if (shopSenior != null) {
            projectRates.rt = shopSenior;
            projectRates.shop_ot = shopSenior * 1.5;
          }
          const ftSenior = project.ft_senior_rate ?? customer?.rate_field_senior;
          if (ftSenior != null) {
            projectRates.ft = ftSenior;
            projectRates.field_ot = ftSenior * 1.5;
          }
        } else {
          // Junior: project.shop_junior_rate ?? customer.rate_shop_junior
          const shopJunior = project.shop_junior_rate ?? customer?.rate_shop_junior;
          if (shopJunior != null) {
            projectRates.rt = shopJunior;
            projectRates.shop_ot = shopJunior * 1.5;
          }
          const ftJunior = project.ft_junior_rate ?? customer?.rate_field_junior;
          if (ftJunior != null) {
            projectRates.ft = ftJunior;
            projectRates.field_ot = ftJunior * 1.5;
          }
        }
        
        // Travel rate: project.travel_rate ?? customer.rate_travel
        const travelRate = project.travel_rate ?? customer?.rate_travel;
        if (travelRate != null) projectRates.tt = travelRate;
        
        employeeRates = projectRates;
      }
      
      ticket = {
        id: ticketKey,
        date,
        customerId,
        customerName,
        location: entryLocation || undefined, // Work location for this ticket
        customerInfo,
        userId,
        userName: entry.user
          ? `${firstName} ${lastName}`.trim() || entry.user.email
          : 'Unknown',
        userInitials: initials,
        userEmail: entry.user?.email,
        projectId: entry.project?.id,
        projectName: entry.project?.name,
        projectNumber: entry.project?.project_number,
        projectLocation: entry.project?.location,
        projectApproverPoAfe: getProjectApproverPoAfe(entry.project) || entry.po_afe || undefined,
        projectApprover: (() => {
          const pf = getProjectHeaderFields(entry.project);
          if (pf.approver || pf.poAfe || pf.cc) return pf.approver;
          return (entry as any).approver || '';
        })(),
        projectPoAfe: (() => {
          const pf = getProjectHeaderFields(entry.project);
          if (pf.approver || pf.poAfe || pf.cc) return pf.poAfe;
          return entry.po_afe || '';
        })(),
        projectCc: (() => {
          const pf = getProjectHeaderFields(entry.project);
          if (pf.approver || pf.poAfe || pf.cc) return pf.cc;
          return (entry as any).cc || '';
        })(),
        projectOther: entry.project?.other,
        entryLocation: entry.location || undefined,
        entryApprover: (entry as any).approver || undefined,
        entryPoAfe: entry.po_afe || undefined,
        entryCc: (entry as any).cc || undefined,
        entryOther: (entry as any).other || undefined,
        totalHours: 0,
        entries: [],
        hoursByRateType: {
          'Shop Time': 0,
          'Shop Overtime': 0,
          'Travel Time': 0,
          'Field Time': 0,
          'Field Overtime': 0,
        },
        rates: employeeRates,
      };
      ticketMap.set(ticketKey, ticket);
    }

    // Add entry to ticket
    ticket.entries.push(entry);
    ticket.totalHours += entry.hours || 0;

    // Aggregate by rate type
    // Convert overtime to regular time for service tickets - overtime must be manually added
    // This allows billing overtime hours as regular time to hide OT from clients
    let rateType = (entry.rate_type || 'Shop Time') as keyof typeof ticket.hoursByRateType;
    if (rateType === 'Shop Overtime') {
      rateType = 'Shop Time';
    } else if (rateType === 'Field Overtime') {
      rateType = 'Field Time';
    }
    
    if (ticket.hoursByRateType.hasOwnProperty(rateType)) {
      ticket.hoursByRateType[rateType] += entry.hours || 0;
    } else {
      // Default to Shop Time if unknown rate type
      ticket.hoursByRateType['Shop Time'] += entry.hours || 0;
    }
  }

  // Convert map to array and sort by date (most recent first)
  return Array.from(ticketMap.values()).sort((a, b) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

/**
 * Format date for display in service tickets
 */
export function formatTicketDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Generate a display ID for a service ticket
 */
export function generateTicketDisplayId(ticket: ServiceTicket): string {
  const datePart = new Date(ticket.date).toISOString().split('T')[0].replace(/-/g, '');
  const customerPart = ticket.customerName.substring(0, 3).toUpperCase();
  return `${datePart}-${customerPart}`;
}

/**
 * Get the sort order for rate types
 * Order: Shop Time, Field Time, Travel Time, then Overtime (Shop/Field)
 */
export function getRateTypeSortOrder(rateType: string): number {
  const order: { [key: string]: number } = {
    'Shop Time': 1,
    'Field Time': 2,
    'Travel Time': 3,
    'Shop Overtime': 4,
    'Field Overtime': 4,
  };
  return order[rateType] || 99;
}

/** Extract AC: value (approver) from combined string - used only for invoicing group keys (legacy approver_po_afe). */
function extractACValue(approverPoAfe: string | undefined): string {
  if (!approverPoAfe) return '';
  const m = approverPoAfe.match(/AC\s*[:\-]?\s*([^\s,;]+)/i);
  return m ? m[1].trim() : '';
}

/** Extract approver code (G### or AC: value) from combined string. Used ONLY for invoicing group keys when legacy approver_po_afe is present. */
export function extractApproverCode(approverPoAfe: string | undefined): string {
  if (!approverPoAfe) return '';
  const acVal = extractACValue(approverPoAfe);
  if (acVal) return acVal;
  const m = approverPoAfe.match(/G\d{3,}/i);
  return m ? m[0].toUpperCase() : (approverPoAfe.trim() || '');
}

/** Build combined approver/PO/AFE/CC string from separate fields. */
export function buildApproverPoAfe(approver: string, poAfe: string, cc: string): string {
  const parts = [approver?.trim(), poAfe?.trim(), cc?.trim()].filter(Boolean);
  return parts.join(' ');
}

/** Billing key delimiter - used to separate approver, PO/AFE, CC in ticket grouping. */
const BILLING_KEY_SEP = '::';

/** Build billing key for ticket grouping - different approver, PO/AFE, or CC create separate tickets. */
export function buildBillingKey(approver: string, poAfe: string, cc: string): string {
  const a = (approver ?? '').trim() || '_';
  const p = (poAfe ?? '').trim() || '_';
  const c = (cc ?? '').trim() || '_';
  return `${a}${BILLING_KEY_SEP}${p}${BILLING_KEY_SEP}${c}`;
}

/** Grouping key for tickets - only PO/AFE/CC (Cost Center) creates new tickets. Approver and Coding do not. Hierarchy: Project > Location > Cost Center (po_afe). */
export function buildGroupingKey(poAfe: string): string {
  const p = (poAfe ?? '').trim() || '_';
  return `_${BILLING_KEY_SEP}${p}${BILLING_KEY_SEP}_`;
}

/** Extract billing key (grouping key) from ticket.id.
 * Ticket format: date-customerId-userId-projectId-_::poAfe::_
 * The grouping key contains hyphens (e.g. FC250375-9086), so we cannot use lastIndexOf('-'). 
 * Instead, find the unique _:: prefix that starts the grouping key. */
export function getTicketBillingKey(ticketId: string): string {
  const idx = ticketId.indexOf('_::');
  return idx >= 0 ? ticketId.slice(idx) : '_::_::_';
}

/** Get combined approver/PO/AFE/CC from project. Uses approver, po_afe, cc columns only. */
export function getProjectApproverPoAfe(project: { approver?: string; po_afe?: string; cc?: string } | null | undefined): string {
  if (!project) return '';
  return buildApproverPoAfe(project.approver ?? '', project.po_afe ?? '', project.cc ?? '');
}

/** Get split Approver, PO/AFE, CC, Other from project for form autopopulation. */
export function getProjectHeaderFields(project: { approver?: string; po_afe?: string; cc?: string; other?: string } | null | undefined): { approver: string; poAfe: string; cc: string; other: string } {
  if (!project) return { approver: '', poAfe: '', cc: '', other: '' };
  return {
    approver: project.approver || '',
    poAfe: project.po_afe || '',
    cc: project.cc || '',
    other: project.other || '',
  };
}

/** Round hours to nearest 0.5 (round up) */
function roundToHalfHour(hours: number): number {
  return Math.ceil(hours * 2) / 2;
}

/** Calculate total billable amount for a service ticket (matches PDF total) */
export function calculateTicketTotalAmount(
  ticket: Pick<ServiceTicket, 'entries' | 'hoursByRateType' | 'rates'>,
  expenses: Array<{ quantity: number; rate: number }> = []
): number {
  const rtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'RT' ? roundToHalfHour(e.hours || 0) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Shop Time'] || 0);
  const ttHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'TT' ? roundToHalfHour(e.hours || 0) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Travel Time'] || 0);
  const ftHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (getRateCode(e.rate_type) === 'FT' ? roundToHalfHour(e.hours || 0) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Field Time'] || 0);
  const shopOtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (e.rate_type === 'Shop Overtime' ? roundToHalfHour(e.hours || 0) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Shop Overtime'] || 0);
  const fieldOtHours = ticket.entries.length > 0
    ? ticket.entries.reduce((sum, e) => sum + (e.rate_type === 'Field Overtime' ? roundToHalfHour(e.hours || 0) : 0), 0)
    : roundToHalfHour(ticket.hoursByRateType['Field Overtime'] || 0);

  const rtAmount = rtHours * (ticket.rates.rt || 0);
  const ttAmount = ttHours * (ticket.rates.tt || 0);
  const ftAmount = ftHours * (ticket.rates.ft || 0);
  const shopOtAmount = shopOtHours * (ticket.rates.shop_ot || 0);
  const fieldOtAmount = fieldOtHours * (ticket.rates.field_ot || 0);
  const expensesTotal = expenses.reduce((sum, e) => sum + (e.quantity * e.rate), 0);
  return rtAmount + ttAmount + ftAmount + shopOtAmount + fieldOtAmount + expensesTotal;
}

function getRateCode(rateType?: string): 'RT' | 'TT' | 'FT' | 'OT' {
  const map: Record<string, 'RT' | 'TT' | 'FT' | 'OT'> = {
    'Shop Time': 'RT',
    'Travel Time': 'TT',
    'Field Time': 'FT',
    'Shop Overtime': 'OT',
    'Field Overtime': 'OT',
  };
  return map[rateType || ''] || 'RT';
}

/** Grouping keys for invoice export: project, approver, location, CC */
export interface InvoiceGroupKey {
  projectId: string;
  projectName?: string;
  projectNumber?: string;
  approverCode: string;
  approver: string;
  poAfe: string;
  location: string;
  cc: string;
  other: string;
}

/** Header overrides from service_tickets.header_overrides (user edits + frozen rates saved on the ticket) */
export interface HeaderOverrides {
  service_location?: string;
  /** @deprecated Use approver, po_afe, cc. Kept for backward compat with old tickets. */
  approver_po_afe?: string;
  approver?: string;
  po_afe?: string;
  cc?: string;
  other?: string;
  customer_name?: string;
  address?: string;
  city_state?: string;
  zip_code?: string;
  phone?: string;
  email?: string;
  contact_name?: string;
  location_code?: string;
  po_number?: string;
  tech_name?: string;
  project_number?: string;
  date?: string;
  /** Frozen rates (approved tickets only) */
  rate_rt?: number;
  rate_tt?: number;
  rate_ft?: number;
  rate_shop_ot?: number;
  rate_field_ot?: number;
}

/** Treat '_' as empty - legacy placeholder when project default was empty */
const emptyIfUnderscore = (v: string | undefined) => (v === '_' ? '' : (v ?? ''));

/** Apply header_overrides to a ticket for PDF export (user edits take precedence).
 * When header_overrides is null, applies fallbacks from ticket.location and entry-level po_afe.
 * For approved tickets, frozen rates are applied when present in header_overrides.
 * NO PARSING: approver, po_afe, cc stay in their own fields - never combined or extracted. */
export function applyHeaderOverridesToTicket(
  ticket: ServiceTicket,
  headerOverrides?: HeaderOverrides | null
): ServiceTicket {
  const ov = headerOverrides && Object.keys(headerOverrides).length > 0 ? headerOverrides : null;
  const entryPo = ticket.entryPoAfe ?? ticket.entries?.find((e) => e.po_afe?.trim())?.po_afe?.trim();
  const locFallback = (ticket.location ?? ticket.projectLocation ?? ticket.customerInfo?.service_location ?? '').trim();

  // Use direct approver/po_afe/cc from overrides - no combining, no parsing
  const approverVal = (ov?.approver != null || ov?.po_afe != null || ov?.cc != null)
    ? emptyIfUnderscore(ov.approver)
    : undefined;
  const poAfeVal = (ov?.approver != null || ov?.po_afe != null || ov?.cc != null)
    ? emptyIfUnderscore(ov.po_afe)
    : undefined;
  const ccVal = (ov?.approver != null || ov?.po_afe != null || ov?.cc != null)
    ? emptyIfUnderscore(ov.cc)
    : undefined;
  // Legacy: approver_po_afe is a single combined string from old tickets
  const legacyApproverName = (ov?.approver_po_afe != null && String(ov.approver_po_afe).trim() !== '')
    ? ov.approver_po_afe
    : undefined;

  const hasFrozenRates = ov && (
    typeof ov.rate_rt === 'number' || typeof ov.rate_tt === 'number' || typeof ov.rate_ft === 'number' ||
    typeof ov.rate_shop_ot === 'number' || typeof ov.rate_field_ot === 'number'
  );
  const rates = hasFrozenRates ? {
    rt: typeof ov!.rate_rt === 'number' ? ov.rate_rt : ticket.rates.rt,
    tt: typeof ov!.rate_tt === 'number' ? ov.rate_tt : ticket.rates.tt,
    ft: typeof ov!.rate_ft === 'number' ? ov.rate_ft : ticket.rates.ft,
    shop_ot: typeof ov!.rate_shop_ot === 'number' ? ov.rate_shop_ot : ticket.rates.shop_ot,
    field_ot: typeof ov!.rate_field_ot === 'number' ? ov.rate_field_ot : ticket.rates.field_ot,
  } : ticket.rates;

  return {
    ...ticket,
    customerInfo: {
      ...ticket.customerInfo,
      name: ov?.customer_name ?? ticket.customerInfo.name,
      contact_name: ov?.contact_name ?? ticket.customerInfo.contact_name,
      address: ov?.address ?? ticket.customerInfo.address,
      city: ov?.city_state?.split(',')[0]?.trim() ?? ticket.customerInfo.city,
      state: ov?.city_state?.split(',')[1]?.trim() ?? ticket.customerInfo.state,
      zip_code: ov?.zip_code ?? ticket.customerInfo.zip_code,
      phone: ov?.phone ?? ticket.customerInfo.phone,
      email: ov?.email ?? ticket.customerInfo.email,
      service_location: ((ov?.service_location ?? ticket.customerInfo.service_location ?? locFallback).trim() || locFallback),
      location_code: ov?.location_code ?? ticket.customerInfo.location_code,
      po_number: ov?.po_number ?? ticket.customerInfo.po_number,
      approver: approverVal ?? ticket.customerInfo.approver ?? undefined,
      po_afe: poAfeVal ?? ticket.customerInfo.po_afe ?? undefined,
      cc: ccVal ?? ticket.customerInfo.cc ?? undefined,
      approver_name: approverVal ?? legacyApproverName ?? ticket.customerInfo.approver_name ?? entryPo ?? undefined,
    },
    projectApproverPoAfe: legacyApproverName ?? ticket.projectApproverPoAfe ?? entryPo ?? undefined,
    projectApprover: approverVal ?? ticket.projectApprover,
    projectPoAfe: poAfeVal ?? ticket.projectPoAfe,
    projectCc: ccVal ?? ticket.projectCc,
    projectOther: (ov?.other != null && ov.other !== '_' && String(ov.other).trim() !== '') ? String(ov.other).trim() : ticket.projectOther,
    entryApprover: approverVal ?? ticket.entryApprover,
    entryPoAfe: poAfeVal ?? ticket.entryPoAfe,
    entryCc: ccVal ?? ticket.entryCc,
    entryOther: (ov?.other != null && ov.other !== '_' && String(ov.other).trim() !== '') ? String(ov.other).trim() : ticket.entryOther,
    rates,
  };
}

/** Get approver/PO/AFE/CC from a ticket - NO PARSING. Uses direct fields only. */
export function getApproverPoAfeCcFromTicket(
  ticket: { projectApprover?: string; projectPoAfe?: string; projectCc?: string; projectApproverPoAfe?: string; entryApprover?: string; entryPoAfe?: string; entryCc?: string; entries?: Array<{ approver?: string; po_afe?: string; cc?: string }> },
  headerOverrides?: { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string } | null
): { approver: string; poAfe: string; cc: string } {
  const ov = headerOverrides;
  if (ov?.approver != null || ov?.po_afe != null || ov?.cc != null) {
    return { approver: emptyIfUnderscore(ov.approver), poAfe: emptyIfUnderscore(ov.po_afe), cc: emptyIfUnderscore(ov.cc) };
  }
  if (ov?.approver_po_afe != null && String(ov.approver_po_afe).trim() !== '') {
    return { approver: ov.approver_po_afe, poAfe: '', cc: '' };
  }
  const entryApprover = ticket.entryApprover ?? ticket.entries?.find((e) => e.approver?.trim())?.approver ?? '';
  const entryPoAfe = ticket.entryPoAfe ?? ticket.entries?.find((e) => e.po_afe?.trim())?.po_afe ?? '';
  const entryWithCc = ticket.entries?.find((e) => (e as any).cc?.trim());
  const entryCc = ticket.entryCc ?? (entryWithCc as any)?.cc ?? '';
  if (entryApprover || entryPoAfe || entryCc) {
    return { approver: entryApprover, poAfe: entryPoAfe, cc: entryCc };
  }
  return {
    approver: ticket.projectApprover ?? '',
    poAfe: ticket.projectPoAfe ?? '',
    cc: ticket.projectCc ?? '',
  };
}

/** @deprecated Use getApproverPoAfeCcFromTicket for direct field access. Legacy combined string. */
export function getApproverPoAfeFromTicket(
  ticket: { projectApproverPoAfe?: string; entryPoAfe?: string; entries?: Array<{ po_afe?: string }> },
  headerOverrides?: { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string } | null
): string {
  const { approver, poAfe, cc } = getApproverPoAfeCcFromTicket(ticket as any, headerOverrides);
  return buildApproverPoAfe(approver, poAfe, cc);
}

/** Get grouping key for a ticket (for invoicing). Uses direct approver/po_afe/cc for header.
 * approverCode uses extractApproverCode only when needed for legacy approver_po_afe - parsing is confined to invoicing groups. */
export function getInvoiceGroupKey(
  ticket: { projectId?: string; projectName?: string; projectNumber?: string; location?: string; projectApprover?: string; projectPoAfe?: string; projectCc?: string; projectApproverPoAfe?: string; projectLocation?: string; projectOther?: string; customerInfo?: { service_location?: string }; entryApprover?: string; entryPoAfe?: string; entryCc?: string; entries?: Array<{ approver?: string; po_afe?: string; cc?: string }> },
  headerOverrides?: { approver_po_afe?: string; approver?: string; po_afe?: string; cc?: string; other?: string; service_location?: string } | null
): InvoiceGroupKey {
  const { approver, poAfe, cc } = getApproverPoAfeCcFromTicket(ticket as any, headerOverrides);
  const location = (headerOverrides?.service_location ?? ticket.location ?? ticket.projectLocation ?? ticket.customerInfo?.service_location ?? '').trim();
  const other = (headerOverrides?.other ?? ticket.projectOther ?? '').trim();
  // Parsing only for invoicing: extract approver code from legacy combined approver_po_afe for grouping
  const approverCode = (headerOverrides?.approver_po_afe && !headerOverrides?.approver && !headerOverrides?.po_afe && !headerOverrides?.cc)
    ? (extractApproverCode(approver) || approver || '_')
    : (approver || '_');
  return {
    projectId: ticket.projectId ?? '',
    projectName: ticket.projectName,
    projectNumber: ticket.projectNumber,
    approverCode,
    approver,
    poAfe,
    location,
    cc,
    other,
  };
}

