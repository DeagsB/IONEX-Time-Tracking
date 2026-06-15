# Handoff: Remove the missing PO/AFE invoice-wizard blocker

This document describes a change made to the IONEX Time-Tracker app so it can be re-implemented
in another copy of the codebase. Self-contained — does not assume access to the original session.
Line numbers will differ between versions; locate code by the function/identifier names given.

Stack: React + TypeScript frontend (`frontend/src`), Supabase (Postgres) backend. Frontend-only
change — no migration, no service-layer change.

Session commits (newest last):
```
b867e31 fix(invoices): PO/AFE missing no longer blocks ready-to-invoice and awaiting-signed
4daa011 fix(invoices): remove PO/AFE missing blocker entirely
```
`b867e31` was an intermediate step (gated the blocker to one queue); `4daa011` is the final state
(blocker removed completely). If re-implementing fresh, **apply only the final state below** — skip
the intermediate gating.

---

## Goal
The invoice wizard ran a set of **pre-flight blockers** ("hard-gate before download") that disabled
the step's primary action button and rendered a red banner until cleared. One of these blockers
fired when a CNRL period batch had any ticket missing a **PO/AFE**. The business no longer wants a
missing PO/AFE to gate invoicing at any stage — remove that blocker entirely. Other blockers
(period still accumulating, unapproved tickets sharing the batch) stay.

## Change — `frontend/src/pages/Invoices.tsx`

In the invoice-wizard active-panel render there is a block commented
`// --- Pre-flight blockers (hard-gate before download) ---` that builds a local
`const blockers: { id: string; message: string; deepLinkTab?: InvoiceTab }[] = []` array. Each
condition `blockers.push({...})`; `const hasBlockers = blockers.length > 0` then disables the
step's primary button and drives the banner.

**Delete the entire PO/AFE block.** It consisted of:
- `const isCnrlPeriodGroup = !!(activeGroup.key.periodKey && activeGroup.key.approverCode && activeGroup.key.approverCode !== activeGroup.key.periodKey);`
- `const missingPoAfe = isCnrlPeriodGroup && activeGroup.tickets.some((t) => { ... getInvoiceGroupKey(...) ...; return !(k.poAfe || '').trim(); });`
- `if (missingPoAfe) { blockers.push({ id: 'po_afe', message: 'One or more tickets are missing a PO/AFE. Fix the headers on the Ready tab before invoicing.', deepLinkTab: 'ready' }); }`

Remove all three. Leave the surrounding `accumulating` and `unapproved` blockers and the
`hasBlockers` line untouched.

### Notes
- `isCnrlPeriodGroup` is declared again under different/local names elsewhere in the file (e.g.
  `isCnrlPeriodGroupForLines` in the line-items render, and separate `isCnrlPeriodGroup` consts in
  other group-key scopes around the project header logic). Those are unrelated — only remove the
  one inside the pre-flight-blockers block. Confirm with a search before deleting.
- `getInvoiceGroupKey` stays imported/used — it has many other call sites. Removing this block does
  not orphan it.
- No banner/UI code needs changing: the banner renders from the `blockers` array generically, so
  dropping the push removes both the gate and the banner entry.

## Verification
- [ ] `tsc --noEmit` passes (`cd frontend && npx tsc --noEmit`).
- [ ] Open the invoice wizard on a CNRL period batch whose tickets have no PO/AFE, in each queue
      (ready-to-invoice, needs-approval, awaiting-signed): no "missing a PO/AFE" banner, primary
      action button enabled.
- [ ] Accumulating / unapproved-ticket blockers still fire when applicable (regression check).
