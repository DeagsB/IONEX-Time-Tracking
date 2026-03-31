/**
 * Financial dashboard insights: week-over-week chart bars, rolling 4-week ticket revenue,
 * completed-month MoM, MTD vs same calendar days last month, plus WIP / liability $ signals.
 */

export type DashboardInsightTone = 'attention' | 'positive' | 'neutral';

export type DashboardInsight = {
  id: string;
  tone: DashboardInsightTone;
  title: string;
  detail: string;
  actionLabel?: string;
  actionPath?: string;
};

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? 100 : null;
  return ((cur - prev) / prev) * 100;
}

function sortInsights(list: DashboardInsight[]): DashboardInsight[] {
  const order = { attention: 0, positive: 1, neutral: 2 };
  return [...list].sort((a, b) => order[a.tone] - order[b.tone] || a.id.localeCompare(b.id));
}

export type DashboardChartWeek = {
  week: string;
  /** Monday YYYY-MM-DD for this bar (matches payroll/calendar week). */
  weekStartKey: string;
  revenue: number;
  totalCost: number;
  profit: number;
};

export type BuildDashboardInsightsInput = {
  revenueByWeek: DashboardChartWeek[];
  /** Monday key for the calendar week containing "today" — latest bar with this key is still filling in. */
  currentWeekStartKey: string;
  uninvoicedWip: number;
  pendingLiability: number;
  topUnbilledCustomer: { name: string; value: number } | null;
  mtdRevenue: number;
  lastMonthRevenue: number;
  monthBeforeLastRevenue: number;
  priorMonthSamePeriodRevenue: number;
  lastMonthLabel: string;
  monthBeforeLastLabel: string;
  currentMonthLabel: string;
};

export function buildDashboardWeeklyInsights(input: BuildDashboardInsightsInput): DashboardInsight[] {
  const {
    revenueByWeek,
    currentWeekStartKey,
    uninvoicedWip,
    pendingLiability,
    topUnbilledCustomer,
    mtdRevenue,
    lastMonthRevenue,
    monthBeforeLastRevenue,
    priorMonthSamePeriodRevenue,
    lastMonthLabel,
    monthBeforeLastLabel,
    currentMonthLabel,
  } = input;

  const insights: DashboardInsight[] = [];

  const nBars = revenueByWeek.length;
  const lastBar = nBars > 0 ? revenueByWeek[nBars - 1] : null;
  const latestWeekIsInProgress =
    lastBar != null &&
    lastBar.weekStartKey === currentWeekStartKey;

  // —— Completed month vs prior month (ticket revenue) ——
  if (lastMonthRevenue > 0 || monthBeforeLastRevenue > 0) {
    const mom = pctChange(lastMonthRevenue, monthBeforeLastRevenue);
    let tone: DashboardInsightTone = 'neutral';
    let title = `Ticket revenue: ${lastMonthLabel}`;
    if (monthBeforeLastRevenue <= 0 && lastMonthRevenue > 0) {
      tone = 'positive';
      title = `Ticket revenue picked up in ${lastMonthLabel}`;
    } else if (mom != null) {
      if (mom <= -7) {
        tone = 'attention';
        title = `Ticket revenue slipped: ${lastMonthLabel} vs ${monthBeforeLastLabel}`;
      } else if (mom >= 5) {
        tone = 'positive';
        title = `Ticket revenue grew: ${lastMonthLabel} vs ${monthBeforeLastLabel}`;
      }
    }
    const momLine =
      monthBeforeLastRevenue > 0 && mom != null
        ? ` (${mom >= 0 ? '+' : ''}${mom.toFixed(0)}% vs ${monthBeforeLastLabel}).`
        : monthBeforeLastRevenue > 0
          ? ` (vs ${fmtMoney(monthBeforeLastRevenue)} in ${monthBeforeLastLabel}).`
          : '.';
    insights.push({
      id: 'mom-ticket-revenue',
      tone,
      title,
      detail: `${fmtMoney(lastMonthRevenue)} on approved-path tickets dated in ${lastMonthLabel}${momLine} Pre-GST rollup; use Employee Reports if you bill GST-inclusive.`,
      actionLabel: 'Employee reports',
      actionPath: '/employee-reports',
    });
  }

  // —— MTD vs same calendar days in last completed month ——
  if (mtdRevenue > 0 || priorMonthSamePeriodRevenue > 0) {
    const pace = pctChange(mtdRevenue, priorMonthSamePeriodRevenue);
    let tone: DashboardInsightTone = 'neutral';
    let title = `${currentMonthLabel} pace vs ${lastMonthLabel} (same days)`;
    if (priorMonthSamePeriodRevenue <= 0 && mtdRevenue > 0) {
      tone = 'positive';
      title = `${currentMonthLabel} has ticket revenue building`;
    } else if (pace != null && priorMonthSamePeriodRevenue > 0) {
      if (pace <= -12) {
        tone = 'attention';
        title = `${currentMonthLabel} is behind last month’s pace`;
      } else if (pace >= 8) {
        tone = 'positive';
        title = `${currentMonthLabel} is ahead of last month’s pace`;
      }
    }
    insights.push({
      id: 'mtd-pace',
      tone,
      title,
      detail: `${fmtMoney(mtdRevenue)} MTD ticket revenue vs ${fmtMoney(priorMonthSamePeriodRevenue)} on the same calendar days in ${lastMonthLabel}${pace != null && priorMonthSamePeriodRevenue > 0 ? ` (${pace >= 0 ? '+' : ''}${pace.toFixed(0)}%).` : '.'}`,
      actionLabel: 'Employee reports',
      actionPath: '/employee-reports',
    });
  }

  // —— Rolling 4 chart weeks vs prior 4 (ticket-week bars) ——
  // When the latest bar is the current week, exclude it so we compare four *completed* weeks to the four before them.
  if (revenueByWeek.length >= 8) {
    const n = revenueByWeek.length;
    let rev4 = 0;
    let prof4 = 0;
    let revPrev4 = 0;
    let profPrev4 = 0;
    let skipRoll = false;

    if (latestWeekIsInProgress && n >= 9) {
      for (let i = n - 5; i <= n - 2; i++) {
        rev4 += revenueByWeek[i].revenue;
        prof4 += revenueByWeek[i].profit;
      }
      for (let i = n - 9; i <= n - 6; i++) {
        revPrev4 += revenueByWeek[i].revenue;
        profPrev4 += revenueByWeek[i].profit;
      }
    } else if (!latestWeekIsInProgress) {
      for (let i = n - 4; i < n; i++) {
        rev4 += revenueByWeek[i].revenue;
        prof4 += revenueByWeek[i].profit;
      }
      for (let i = n - 8; i < n - 4; i++) {
        revPrev4 += revenueByWeek[i].revenue;
        profPrev4 += revenueByWeek[i].profit;
      }
    } else {
      skipRoll = true;
    }

    if (!skipRoll) {
      const revCh = pctChange(rev4, revPrev4);
      const profCh = pctChange(prof4, profPrev4);
      let tone: DashboardInsightTone = 'neutral';
      let title = latestWeekIsInProgress
        ? 'Last four completed chart weeks vs the four before (current week excluded)'
        : 'Last 4 chart weeks vs the 4 before';
      if (revCh != null && revCh <= -10) {
        tone = 'attention';
        title = latestWeekIsInProgress
          ? 'Completed chart weeks: ticket revenue down vs the prior block'
          : 'Ticket-week revenue down over the last month of bars';
      } else if (revCh != null && revCh >= 6 && prof4 >= profPrev4 - 1) {
        tone = 'positive';
        title = latestWeekIsInProgress
          ? 'Completed chart weeks: ticket revenue up vs the prior block'
          : 'Ticket-week revenue up over the last month of bars';
      } else if (prof4 < 0 && profPrev4 >= 0) {
        tone = 'attention';
        title = latestWeekIsInProgress
          ? 'Completed chart weeks flipped to net cost vs revenue'
          : 'Chart weeks recently flipped to net cost vs revenue';
      }
      const revPart = revCh != null ? `${revCh >= 0 ? '+' : ''}${revCh.toFixed(0)}% revenue` : 'revenue change n/a';
      const profPart =
        profPrev4 !== 0 || prof4 !== 0
          ? `; profit ${fmtMoney(profPrev4)} → ${fmtMoney(prof4)}${profCh != null ? ` (${profCh >= 0 ? '+' : ''}${profCh.toFixed(0)}%)` : ''}`
          : '';
      insights.push({
        id: 'roll-4w',
        tone,
        title,
        detail: `Summed from the weekly chart above (ticket-date revenue vs costs): ${revPart}${profPart}.`,
      });
    }
  }

  // —— Latest two chart weeks (WoW) ——
  if (revenueByWeek.length >= 2) {
    const a = revenueByWeek[revenueByWeek.length - 2];
    const b = revenueByWeek[revenueByWeek.length - 1];

    if (latestWeekIsInProgress) {
      insights.push({
        id: 'chart-week-in-progress',
        tone: 'neutral',
        title: `Latest chart week still in progress (${b.week})`,
        detail: `WoW % and “in the red” are skipped here: this week’s bar only has ticket-dated revenue and matched labor so far, while ${a.week} is a full week—so side‑by‑side % and profit are not comparable yet. Rolling trends above exclude the open week when possible.`,
      });
    } else {
      const pr = pctChange(b.revenue, a.revenue);
      const pp = pctChange(b.profit, a.profit);

      if (a.revenue > 0 || b.revenue > 0) {
        let tone: DashboardInsightTone = 'neutral';
        if (pr != null) {
          if (pr <= -8) tone = 'attention';
          else if (pr >= 5) tone = 'positive';
        }
        insights.push({
          id: 'wow-revenue',
          tone,
          title:
            pr != null && pr <= -8
              ? 'Latest chart week: ticket revenue dropped vs prior bar'
              : pr != null && pr >= 5
                ? 'Latest chart week: ticket revenue up vs prior bar'
                : 'Latest chart week: ticket revenue vs prior bar',
          detail: `${fmtMoney(a.revenue)} (${a.week}) → ${fmtMoney(b.revenue)} (${b.week})${pr != null ? ` (${pr >= 0 ? '+' : ''}${pr.toFixed(0)}%).` : '.'}`,
        });
      }

      if (b.profit < 0) {
        insights.push({
          id: 'wow-profit-loss',
          tone: 'attention',
          title: `Latest chart week in the red (${b.week})`,
          detail: `Revenue ${fmtMoney(b.revenue)} vs cost ${fmtMoney(b.totalCost)} on that bar (ticket expenses plus labor matched to those tickets; see dashboard chart footnote).`,
          actionLabel: 'Profitability',
          actionPath: '/profitability',
        });
      } else if (a.profit > 0 && b.profit > 0 && pp != null && pp <= -20) {
        insights.push({
          id: 'wow-profit-slip',
          tone: 'attention',
          title: 'Latest chart week: profit squeezed vs prior bar',
          detail: `Profit went from ${fmtMoney(a.profit)} (${a.week}) to ${fmtMoney(b.profit)} (${b.week}) (${pp.toFixed(0)}%).`,
          actionLabel: 'Profitability',
          actionPath: '/profitability',
        });
      } else if (a.revenue > 0 && b.profit / b.revenue >= 0.18 && b.profit > a.profit) {
        insights.push({
          id: 'wow-margin-strong',
          tone: 'positive',
          title: `Healthy margin on the latest chart week (${b.week})`,
          detail: `Roughly ${((b.profit / b.revenue) * 100).toFixed(0)}% margin (${fmtMoney(b.profit)} on ${fmtMoney(b.revenue)}), up from ${fmtMoney(a.profit)} the week before.`,
        });
      }
    }
  } else if (revenueByWeek.length === 1) {
    const latest = revenueByWeek[0];
    const onlyBarIsThisWeek = latest.weekStartKey === currentWeekStartKey;
    if (latest.profit < 0) {
      if (onlyBarIsThisWeek) {
        insights.push({
          id: 'single-bar-in-progress',
          tone: 'neutral',
          title: `Chart week ${latest.week} is still open`,
          detail: `Revenue ${fmtMoney(latest.revenue)} vs cost ${fmtMoney(latest.totalCost)} so far—profit on this bar usually isn’t meaningful until the week is further along.`,
        });
      } else {
        insights.push({
          id: 'single-bar-loss',
          tone: 'attention',
          title: `Only chart week so far is in the red (${latest.week})`,
          detail: `Revenue ${fmtMoney(latest.revenue)} vs cost ${fmtMoney(latest.totalCost)}.`,
          actionLabel: 'Profitability',
          actionPath: '/profitability',
        });
      }
    } else if (latest.revenue > 0 && latest.profit / latest.revenue >= 0.18) {
      insights.push({
        id: 'single-bar-margin',
        tone: 'positive',
        title: `Solid margin on the latest chart week (${latest.week})`,
        detail: `Roughly ${((latest.profit / latest.revenue) * 100).toFixed(0)}% margin (${fmtMoney(latest.profit)} on ${fmtMoney(latest.revenue)}).`,
      });
    }
  }

  // —— WIP & cash-adjacent (not ops queues) ——
  if (uninvoicedWip >= 50_000) {
    insights.push({
      id: 'wip-high',
      tone: 'attention',
      title: 'Large uninvoiced WIP',
      detail: `${fmtMoney(uninvoicedWip)} on submitted tickets without invoice numbers ties up clarity and cash timing.`,
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets?overview=open&tab=submitted',
    });
  } else if (uninvoicedWip > 0 && uninvoicedWip < 12_000) {
    insights.push({
      id: 'wip-contained',
      tone: 'positive',
      title: 'Uninvoiced WIP is relatively small',
      detail: `${fmtMoney(uninvoicedWip)} remains without invoice numbers.`,
    });
  } else if (uninvoicedWip > 0) {
    insights.push({
      id: 'wip-mid',
      tone: 'neutral',
      title: 'Uninvoiced WIP',
      detail: `${fmtMoney(uninvoicedWip)} on tickets still waiting for invoice numbers.`,
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets',
    });
  }

  if (topUnbilledCustomer && topUnbilledCustomer.value >= 40_000) {
    insights.push({
      id: 'top-unbilled',
      tone: 'attention',
      title: 'Concentrated unbilled WIP',
      detail: `${topUnbilledCustomer.name}: about ${fmtMoney(topUnbilledCustomer.value)} without an invoice number.`,
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets',
    });
  } else if (topUnbilledCustomer && topUnbilledCustomer.value >= 15_000) {
    insights.push({
      id: 'top-unbilled-context',
      tone: 'neutral',
      title: 'Largest unbilled customer',
      detail: `${topUnbilledCustomer.name}: about ${fmtMoney(topUnbilledCustomer.value)} in uninvoiced WIP.`,
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets',
    });
  }

  if (pendingLiability >= 5_000) {
    insights.push({
      id: 'pending-liability',
      tone: 'attention',
      title: 'Elevated pending receipt liability',
      detail: `${fmtMoney(pendingLiability)} in employee receipts still pending approval.`,
      actionLabel: 'Expenses',
      actionPath: '/expenses?overview=open&tab=pending',
    });
  } else if (pendingLiability >= 500) {
    insights.push({
      id: 'pending-liability-context',
      tone: 'neutral',
      title: 'Pending receipt liability',
      detail: `${fmtMoney(pendingLiability)} awaiting expense approval.`,
      actionLabel: 'Expenses',
      actionPath: '/expenses?overview=open&tab=pending',
    });
  }

  return sortInsights(insights);
}
