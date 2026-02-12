# Migration removal notes – when data is fully migrated

Use this when you're ready to remove the old way of doing things after all data has been migrated to the correct fields.

---

## 1. Remove `approver_po_afe` column (use `approver`, `po_afe`, `cc` only)

**Before:** Verify all projects have `approver`, `po_afe`, `cc` populated correctly. Run a quick check:

```sql
-- Check for any rows still relying on approver_po_afe when new columns are empty
SELECT id, name, approver_po_afe, approver, po_afe, cc
FROM public.projects
WHERE (approver_po_afe IS NOT NULL AND approver_po_afe != '')
  AND (approver IS NULL OR approver = '')
  AND (po_afe IS NULL OR po_afe = '')
  AND (cc IS NULL OR cc = '');
```

If this returns rows, backfill or fix them before removing the column.

### Database migration

```sql
ALTER TABLE public.projects DROP COLUMN IF EXISTS approver_po_afe;
```

### Code changes

- **frontend/src/pages/Projects.tsx**
  - `handleEdit`: Remove `parseApproverPoAfe`, `parseOtherFieldForPrefixes` fallbacks. Use only `project.approver`, `project.po_afe`, `project.cc`.
  - `createMutation` / `updateMutation`: Remove `approver_po_afe` from payload. Keep only `approver`, `po_afe`, `cc`.

- **frontend/src/utils/serviceTickets.ts**
  - `getProjectApproverPoAfe()`: Remove fallback to `project.approver_po_afe`. Use only `approver`, `po_afe`, `cc`.
  - `TimeEntryWithRelations.project`: Remove `approver_po_afe` from type.

- **frontend/src/services/supabaseServices.ts**
  - Remove any `approver_po_afe` from selects/inserts.

- **service_tickets.header_overrides**: If `approver_po_afe` is stored there, switch to `approver`, `po_afe`, `cc` keys (or keep combined string for display).

### Search terms

- `approver_po_afe`
- `projectApproverPoAfe`

---

## 2. Remove parsing migration (CC:, AC:, PO:, AFE: prefixes)

The parsing for CC:, AC:, PO:, AFE: prefixes and extraction from the "other" field was temporary migration logic. Once employees input data directly into the correct fields (Approver, PO/AFE, CC), this can be removed.

### Files to update

1. **frontend/src/utils/serviceTickets.ts**
   - Remove: `extractACValue`, `extractAFEValue`, `PLAIN_NUMBER_CC`
   - Simplify: `extractApproverCode` (remove AC handling), `extractCcValue`, `extractPoValue`
   - Remove: `parseApproverPoAfe`, `parseOtherFieldForPrefixes`
   - Simplify: `buildApproverPoAfe` to just join values (no prefix stripping)

2. **frontend/src/pages/ServiceTickets.tsx**
   - Replace `parseApproverPoAfe` with direct field mapping from approver_po_afe (or split storage)
   - Remove `parseOtherFieldForPrefixes` calls in initialEditable and merge logic

3. **frontend/src/pages/Projects.tsx**
   - Replace `parseApproverPoAfe` in handleEdit with direct field mapping
   - Remove `parseOtherFieldForPrefixes` in handleEdit

4. **frontend/src/utils/pdfFromHtml.ts**
   - Update to use approver, poAfe, cc from ticket without parsing

5. **frontend/src/pages/Invoices.tsx**
   - Remove `extractCcValue`, `extractPoValue` usage if still present

### Search terms

- `parseApproverPoAfe`
- `parseOtherFieldForPrefixes`
- `extractCcValue`
- `extractPoValue`
- `MIGRATION PARSING`
