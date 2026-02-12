# Migration parsing – remove when migration is complete

The parsing for CC:, AC:, PO:, AFE: prefixes and extraction from the "other" field was temporary migration logic. Once employees input data directly into the correct fields (Approver, PO/AFE, CC), this can be removed.

## Files to update

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

## Search terms

- `parseApproverPoAfe`
- `parseOtherFieldForPrefixes`
- `extractCcValue`
- `extractPoValue`
- `MIGRATION PARSING`
