# Employee Report: Profitability Calculation Changes

This document describes the changes between the previous Employee Report and the current implementation, and explains why profitability figures may appear lower than before.

---

## Summary of Changes

| Aspect | Before | After |
|--------|--------|-------|
| **Revenue** | Hours × billable rate (estimated) | `total_amount` from approved/exported service tickets only |
| **Labor Cost** | Base pay rate × hours | (Base pay × burden) × hours, using historical rates per entry date |
| **Expense Cost** | Not included or minimal | All service ticket expenses (quantity × rate) per employee |
| **Burden** | Not applied or fixed 30% | Calculated from employee data (benefits, CPP, EI, allowances) |
| **Pay Rates** | Current rates only | Historical rates from pay rate history per entry date |

---

## 1. Revenue: From Estimated to Actual

### Before
- Revenue was calculated as **billable hours × billable rate**.
- This was an *estimate* based on the hours logged and the employee’s billable rates.
- It did not reflect discounts, minimums, or other adjustments made on service tickets.

### After
- Revenue is taken from **`total_amount`** on approved/exported service tickets only.
- Draft, submitted, and rejected tickets do **not** contribute to revenue.
- This matches the Profitability page and reflects what is actually billed.

### Why Profitability Drops
- If tickets are billed at less than the standard rate (discounts, negotiated rates, minimums), revenue is lower than the old estimate.
- Only approved/exported tickets count; pending tickets no longer inflate revenue.

---

## 2. Labor Cost: Burden and Historical Rates

### Before
- Labor cost was often **base pay rate × hours**.
- No burden (benefits, taxes, allowances) was applied.
- Current pay rates were used for all periods.

### After
- Labor cost = **(base pay × burden multiplier) × hours**.
- **Burden** is calculated from employee data:
  - **Employees:** sick pay %, stat holiday %, vacation %, employer CPP (5.95%), employer EI (2.32%), cell phone allowance, health allowance.
  - **Contractors:** 5% (GST).
- **Historical rates** are used: pay rate history is applied by entry date, so past periods use the rates that were in effect at that time.

### Why Profitability Drops
- Adding burden increases labor cost (often by 20–35% for employees).
- Historical rates ensure cost reflects actual pay at the time, which can be higher than previously assumed.

---

## 3. Expense Cost: Now Included

### Before
- Service ticket expenses (travel, subsistence, equipment, etc.) were not included in employee cost.

### After
- **Expense cost** = only reimbursable expenses, using payback percentages. Billed expenses (needs_reimbursement=false) = 0. Reimbursable: amount × reimb_rate (mileage 90%, per diem 100%, etc.). Parts/other billed but not reimbursed do not affect profitability; markup counts as profit.
### Why Profitability Drops
- Expenses reduce profit. Previously they were not counted in the employee report.

---

## 4. Cost Breakdown

**Total Cost** = **Labor Cost** + **Expense Cost**

- **Labor Cost** = Internal time cost + Shop time cost + Field time cost + Travel time cost + Overtime costs (all with burden applied).
- **Expense Cost** = Sum of (amount × reimb_rate) for reimbursable expenses only; billed-only expenses = 0.

---

## 5. Profit Calculation

**Net Profit** = Total Revenue − Total Cost

**Profit Margin** = (Net Profit ÷ Total Revenue) × 100

---

## 6. Example: Why an Employee’s Profit May Drop

Consider an employee whose profit went from ~$7,000 to a ~$1,700 loss:

1. **Revenue**
   - Old: Hours × billable rate (e.g. 100 hrs × $80 = $8,000).
   - New: Actual `total_amount` from approved tickets (e.g. $6,500 after discounts/minimums).
   - **Effect:** Revenue is lower.

2. **Labor Cost**
   - Old: 100 hrs × $25/hr = $2,500 (no burden).
   - New: 100 hrs × $25 × 1.30 (burden) = $3,250.
   - **Effect:** Labor cost is higher.

3. **Expense Cost**
   - Old: $0 (not included).
   - New: $1,500 in ticket expenses.
   - **Effect:** Total cost increases.

4. **Result**
   - Old: $8,000 − $2,500 = **$5,500 profit** (or higher with inflated revenue).
   - New: $6,500 − $3,250 − $1,500 = **$1,750 profit** (or a loss if revenue is lower or costs higher).

---

## 7. Alignment with Other Reports

The Employee Report now aligns with:

- **Profitability page:** Same revenue source (`total_amount` from approved tickets) and cost logic.
- **Payroll:** Uses the same burden and historical rate concepts.
- **Service tickets:** Revenue reflects what is actually billed, not estimated.

---

## 8. What Has Not Changed

- Billable vs non-billable hours logic.
- Rate type breakdown (Shop Time, Field Time, Travel Time, etc.).
- Project and customer breakdown structure (now using `total_amount` for revenue).
- Billable bar segments (approved vs pending vs non-billable).

---

## 9. Recommendations

If profitability appears too low:

1. **Review billing:** Ensure approved tickets use correct `total_amount` and that discounts/minimums are intentional.
2. **Review burden:** Confirm sick, stat, vacation, CPP, EI, and allowances are set correctly for each employee.
3. **Review expenses:** Verify ticket expenses are accurate and necessary.
4. **Review pay rates:** Ensure pay rate history matches actual pay for each period.
