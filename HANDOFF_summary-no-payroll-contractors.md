# Handoff: Batch Summary Number + Payroll/Contractor changes

This document describes a set of changes made to the IONEX Time-Tracker app so they can be
re-implemented in another copy of the codebase. It is self-contained — it does not assume
access to the original session. Line numbers will differ between versions; locate code by the
function/identifier names given.

Stack: React + TypeScript frontend (`frontend/src`), Supabase (Postgres) backend. The three
features below are independent and can be applied separately.

Session commits (for reference, newest last):
```
28c564c feat(invoices): per-project Summary Number for each batch summary
9212ced feat(invoices): label downloads with Summary No.; show it in the wizard
59164d2 fix(invoices): only show Summary No. for batches actually awaiting signed
c005630 feat(invoices): batch download filename is just the Summary No.
caf9fbc feat(payroll): show project number before name in the breakdown dropdown
4ecea60 feat(payroll/expenses): contractors are period-scoped, not accounted-for
65991e3 fix(payroll): project column reads "number - name", not greyed
```

---

## Feature 1 — Per-project "Summary Number" for invoice batches

### Goal
An invoice batch's **Service Ticket Summary** (the cover page that bundles many service tickets)
currently lists every ticket number. Clients want **one stable id** to reference for their cost
tracking instead. Add a per-project sequential **Summary Number** formatted `{projectNumber}-{NNN}`
(e.g. `26012-007`), allocated once and frozen per batch.

### Key design decisions (important)
- **Allocated at summary-PDF generation time, NOT when the batch is marked.** In the
  submit-for-approval flow the summary PDF is built and downloaded *before* the
  `invoiced_batch_marks` row exists. So the number lives in its own table, allocated lazily, and
  is idempotent (re-downloads reuse it).
- **Per-project _counter_, not a derived project+period string.** Project+period is NOT unique to
  a batch: CNRL batches split by approver, and partial-month/residual splits reuse the same
  project+period. A derived id would collide; a counter does not.
- **Keyed by the resolved persist group id** (`resolvedPersistGroupId`) so it survives ticket
  moves via the existing heal logic. Sequence gaps are acceptable (a previewed-then-regrouped
  batch) — it's a reference id, not a gapless ledger.

### 1a. Database migration
Create `sql/migrations/migration_create_invoice_batch_summary_nos.sql` (and copy to
`supabase/migrations/` if that mirror is used). Requires an existing `public.is_admin()` helper
and `public.users` table (both already present in this app).

```sql
-- Per-project running counter (TEXT key — group keys aren't guaranteed clean UUIDs).
CREATE TABLE IF NOT EXISTS public.invoice_summary_counters (
  project_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- One frozen Summary Number per batch. group_id = resolvedPersistGroupId on the client.
CREATE TABLE IF NOT EXISTS public.invoice_batch_summary_nos (
  group_id TEXT PRIMARY KEY,
  project_id TEXT,
  summary_no TEXT NOT NULL UNIQUE,
  allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by UUID REFERENCES public.users (id) ON DELETE SET NULL
);

ALTER TABLE public.invoice_summary_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_batch_summary_nos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage invoice_summary_counters" ON public.invoice_summary_counters;
CREATE POLICY "Admins manage invoice_summary_counters" ON public.invoice_summary_counters
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage invoice_batch_summary_nos" ON public.invoice_batch_summary_nos;
CREATE POLICY "Admins manage invoice_batch_summary_nos" ON public.invoice_batch_summary_nos
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Idempotent, atomic allocation. SECURITY DEFINER so counter-bump + insert run as one unit;
-- the body still enforces is_admin(). The prefix is sanitized to filename/HTML-safe chars.
CREATE OR REPLACE FUNCTION public.allocate_batch_summary_no(
  p_group_id TEXT,
  p_project_id TEXT,
  p_project_number TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing TEXT;
  v_seq INTEGER;
  v_prefix TEXT;
  v_result TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT summary_no INTO v_existing
  FROM public.invoice_batch_summary_nos WHERE group_id = p_group_id;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.invoice_summary_counters (project_id, last_seq)
  VALUES (COALESCE(NULLIF(TRIM(p_project_id), ''), '_'), 1)
  ON CONFLICT (project_id)
  DO UPDATE SET last_seq = public.invoice_summary_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  v_prefix := COALESCE(NULLIF(TRIM(p_project_number), ''), NULLIF(TRIM(p_project_id), ''), 'BATCH');
  -- Keep only filename/HTML-safe characters so the stored value is safe everywhere it renders.
  v_prefix := regexp_replace(v_prefix, '[^A-Za-z0-9_-]', '', 'g');
  v_prefix := COALESCE(NULLIF(v_prefix, ''), 'BATCH');
  v_result := v_prefix || '-' || LPAD(v_seq::TEXT, 3, '0');

  INSERT INTO public.invoice_batch_summary_nos (group_id, project_id, summary_no, allocated_by)
  VALUES (p_group_id, COALESCE(NULLIF(TRIM(p_project_id), ''), '_'), v_result, auth.uid());

  RETURN v_result;
END;
$$;

-- Lock down: anon never needs it (body still enforces is_admin()).
REVOKE EXECUTE ON FUNCTION public.allocate_batch_summary_no(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.allocate_batch_summary_no(TEXT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.allocate_batch_summary_no(TEXT, TEXT, TEXT) TO authenticated;
```

### 1b. Service layer — `frontend/src/services/supabaseServices.ts`
Add after `invoicedBatchMarksService`:

```ts
/**
 * Per-project Summary Number for each invoice batch (the Service Ticket Summary cover).
 * Allocated lazily at summary-PDF generation time and frozen; re-downloads reuse the number.
 */
export const batchSummaryNoService = {
  /** group_id → summary_no for every batch that has one. */
  async getAll(): Promise<Record<string, string>> {
    const { data, error } = await supabase
      .from('invoice_batch_summary_nos')
      .select('group_id, summary_no');
    if (error) throw error;
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      const r = row as { group_id: string; summary_no: string };
      if (r.group_id && r.summary_no) out[r.group_id] = r.summary_no;
    }
    return out;
  },
  /** Allocate (or return existing) Summary Number for a batch. Idempotent on groupId. */
  async allocate(groupId: string, projectId: string, projectNumber: string): Promise<string> {
    const { data, error } = await supabase.rpc('allocate_batch_summary_no', {
      p_group_id: groupId,
      p_project_id: projectId ?? '',
      p_project_number: projectNumber ?? '',
    });
    if (error) throw error;
    return String(data);
  },
};
```

### 1c. PDF — `frontend/src/utils/pdfFromHtml.ts`
1. Add an HTML-escape helper near the top (the file builds HTML via string interpolation and
   renders it with `innerHTML`, so user-derived values must be escaped):
   ```ts
   function escapeHtml(s: string): string {
     return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
             .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
   }
   ```
2. `generateBatchSummaryPdf(...)`: add a trailing `summaryNo?: string` param and pass it into
   `buildBatchSummaryPdfHtml(...)`.
3. `buildBatchSummaryPdfHtml(...)`: add a trailing `summaryNo?: string` param. The header has an
   empty top-right cell (`<div style="width: 140px; text-align: right;">`). Render there:
   ```ts
   ${summaryNo ? `
     <div style="font-size: 7.5pt; color: #555; text-transform: uppercase; letter-spacing: 1px;">Summary No.</div>
     <div style="font-size: 13pt; font-weight: bold; color: #000;">${escapeHtml(summaryNo)}</div>` : ''}
   ```

### 1d. Invoices page — `frontend/src/pages/Invoices.tsx`
Import `batchSummaryNoService`.

**Query the map + helpers** (place near the `invoicedMarkRows` query):
```ts
const { data: batchSummaryNos = {} } = useQuery({
  queryKey: ['batchSummaryNos'],
  queryFn: () => batchSummaryNoService.getAll(),
  enabled: loadInvoicedBatchMarks,
});

/** Already-allocated Summary Number for a batch (drift-tolerant). */
const summaryNoForGroup = useCallback(
  (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }): string | undefined => {
    const pid = resolvedPersistGroupId(group, invoicedMarkRows);
    return batchSummaryNos[pid] ?? batchSummaryNos[getGroupId(group)];
  },
  [batchSummaryNos, invoicedMarkRows]
);

/** Allocate (or fetch existing) before generating a summary PDF. Skipped in demo mode. */
const ensureSummaryNo = useCallback(
  async (group: { key: InvoiceGroupKeyWithPeriod; tickets: ServiceTicket[] }, persistId: string): Promise<string | undefined> => {
    const existing = batchSummaryNos[persistId] ?? batchSummaryNos[getGroupId(group)];
    if (existing) return existing;
    if (isDemoMode) return undefined;
    try {
      const no = await batchSummaryNoService.allocate(persistId, group.key.projectId ?? '', group.key.projectNumber ?? '');
      queryClient.invalidateQueries({ queryKey: ['batchSummaryNos'] });
      return no;
    } catch (e) { console.warn('Failed to allocate Summary Number:', e); return undefined; }
  },
  [batchSummaryNos, isDemoMode, queryClient]
);
```

**Allocate + pass into every `generateBatchSummaryPdf(...)` call.** There are ~4 call sites
(merged-batch builder `buildMergedBatchPdfBlob`, single-group export, download-with-invoice,
bulk export). At each, resolve the persist id for the group and call
`const summaryNo = await ensureSummaryNo(group, persistId);` then pass `summaryNo` as the new
last arg to `generateBatchSummaryPdf(...)`.

**Filenames — make the downloaded batch file just `<summary-no>.pdf`.** Three builders gain a
trailing `summaryNo?: string`; when present it IS the whole filename, everything else dropped:
- `getApprovalBatchFilename(key, tickets, projects, summaryNo?)` → `if (sn) return \`${sanitizeFilenamePart(sn)}.pdf\`;`
- `getInvoicePdfFilename(key, tickets, summaryNo?)` → `if (sn) return \`${sn.replace(/[/\\?*:|"]/g,'_')}.pdf\`;`
- `mergedInvoiceBatchDownloadFilename(sourceInvoiceName, summaryNo?)` → `if (sn) return \`${sanitizeFilenamePart(sn)}.pdf\`;`
Update every call site to pass `summaryNoForGroup(group)` (the group/`g`/`activeGroup` in scope).

**UI badge (Invoiced tab batch row).** Where the row renders `#{projectNumber}`, also show a
mono badge `{batchSummaryNos[persistId]}` when present.

**Wizard display + the bug fix.** In the invoice wizard:
- Queue card and the active-panel "summary block": show the Summary Number **instead of** the
  project # — but ONLY for batches genuinely awaiting a signed PDF.
- **Gate on the batch's real status, not the selected queue.** The wizard cards render from an
  `effectiveQueue` that falls back to another queue when the selected one is empty; gating on
  `wizardQueue === 'awaiting_signed'` wrongly labelled unmarked fallback batches. Use the batch
  status instead:
  ```ts
  // queue card (cStatusId is getGroupStatusId(c.group), already in scope):
  const cSummaryNo = cStatusId === 'submitted_approval' ? summaryNoForGroup(c.group) : undefined;
  const label = cSummaryNo ?? (c.group.key.projectNumber?.trim() ? `#${c.group.key.projectNumber.trim()}` : '');

  // active panel:
  const activeSummaryNo = getGroupStatusId(activeGroup) === 'submitted_approval'
    ? summaryNoForGroup(activeGroup) : undefined;
  // render a "Summary No." row only when activeSummaryNo is set.
  ```
  (`submitted_approval` is the status the "awaiting signed" queue is built from.)

### 1e. Apply the migration
Run the SQL against the DB (Supabase SQL editor, CLI, or MCP `apply_migration`). Until it runs,
summary generation still works — `allocate` fails softly and the PDF/filename just omit the number.

---

## Feature 2 — Payroll: project number in the breakdown dropdown

In `frontend/src/pages/Payroll.tsx`, the per-employee expandable breakdown
(`EmployeeProjectsAndDailyBreakdown`) groups hours by project (the `byProject` map) under the
**"Hours by rate type"** table. Show the project number with the name.

1. Add `number` to the `byProject` map value type:
   `Map<string, { name: string; number: string; customer: string; hours: number; byRateType: Map<string, number> }>`
2. When building it, capture `const projNum = e.project?.project_number || '';` and set
   `number: projNum` on first insert.
3. Render the project cell as **`number - name`** in normal text (NOT greyed):
   ```tsx
   <td>{p.number ? `${p.number} - ${p.name}` : p.name}</td>
   ```
   (Final form per the user: plain "26012 - Project Name", no muted/monospace prefix span.)

---

## Feature 3 — Contractors are period-scoped, not "accounted for"

**Business rule:** contractors (`employment_type === 'Contractor'`) invoice the company directly
and are assumed paid each pay period (settling the invoice is their responsibility). We keep their
expense lines only to verify their invoices. So they must not run through the employee
reimbursement/accounted-for/carry-forward machinery.

### 3a. Payroll — `frontend/src/pages/Payroll.tsx`
There is a `contractorByUserId` map (`user_id → boolean`). The reimbursement logic
(`reimbursementsByUser`) pulls unpaid prior-period lines into the current period via "catch-up"
queries (`catchUpReceipts`, `catchUpTicketExpenses`) — this is the **carry-forward**. For
contractors, disable it and scope strictly to the period.

1. Tag the rollover rows so they can be excluded. In the `catchUpReceipts` and
   `catchUpTicketExpenses` memos, map each row to `({ ...r, _isCatchUp: true })`.
2. In the **ticket-expense loop** of `reimbursementsByUser`, after resolving `userId`:
   ```ts
   const isContractor = contractorByUserId.get(String(userId)) === true;
   if (isContractor) {
     if (exp._isCatchUp) continue;            // no carry forward
   } else if (!isCurrentPeriod && exp.reimbursement_status !== 'paid') {
     continue;                                 // employees: existing roll-forward rule
   }
   ```
   (Previously the second condition was unconditional.)
3. In the **receipt loop**, move `const userId = exp.user_id; if (!userId) continue;` above the
   period checks and apply the same pattern with `exp.status !== 'paid'`.
4. When pushing lines, treat contractor lines as paid:
   `isPaid: isContractor || exp.reimbursement_status === 'paid'` (ticket loop) and
   `isPaid: isContractor || exp.status === 'paid'` (receipt loop).
5. Add `contractorByUserId` to the `reimbursementsByUser` dependency array.

Net effect: contractor reimbursements show only in the period they're dated (no carry-forward in
the current period; past-period lines show in their own period regardless of status), treated as
settled.

### 3b. Expenses — `frontend/src/pages/Expenses.tsx`
The dedicated **Contractors tab** is view-only (no Account-for button) but still showed an
"accounted for" notion that could never clear. Remove it:
1. Delete the per-contractor **"N unaccounted"** badge (the `userGroup.unaccountedCount > 0`
   pill) in the contractor section header. (Keep the identical badge on the *Auto-reimbursed*
   tab — employees there do get accounted.)
2. Change the **Contractors tab count badge** from
   `contractorTicketExpenseRows.filter(r => r.reimbursement_status !== 'paid').length` to
   `contractorTicketExpenseRows.length` (informational volume, not an action count).
3. Default the Contractors tab to **collapsed**: the seed effect that collapsed only
   `unaccountedCount === 0` groups should collapse all —
   `setCollapsedContractorUserKeys(new Set(contractorRowsGroupedByUser.map(u => u.userId)))`.

(The Reconcile tab already excludes contractors — no change needed there.)

---

## Verification checklist
- [ ] Run the migration; confirm tables, function, and 2 policies exist.
- [ ] Send a batch for approval → downloaded file is named `<summary-no>.pdf`; the Service Ticket
      Summary cover shows "Summary No. 26012-007" top-right.
- [ ] Re-download the same batch → same number (idempotent).
- [ ] Move a ticket in/out of a batch → number stays attached.
- [ ] Wizard with an empty Awaiting-Signed queue, on an unmarked batch → card shows the project #
      (not a Summary No.). A real submitted_approval batch shows the Summary No.
- [ ] Payroll breakdown project column reads "26012 - Name", not greyed.
- [ ] Payroll, contractor included (toggle off "exclude contractors"): reimbursements show only
      in their dated period; nothing carries into the current period.
- [ ] Expenses Contractors tab: no "unaccounted" badge, collapsed by default, badge = line count.

`tsc --noEmit` should pass after each feature.
```
