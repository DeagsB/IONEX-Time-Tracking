/**
 * Rule-based weekly insights for the admin dashboard (tickets, time, WIP, queues).
 * Tones: attention = needs follow-up, positive = momentum / healthy, neutral = context.
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

export type BuildDashboardInsightsInput = {
  revenueByWeek: { week: string; revenue: number; totalCost: number; profit: number }[];
  uninvoicedWip: number;
  pendingLiability: number;
  topUnbilledCustomer: { name: string; value: number } | null;
  awaitingReviewCount: number;
  resubmittedCount: number;
  pendingExpenseCount: number;
  missingNumberCount: number;
  openBugCount: number;
  totalActionItems: number;
  mtdRevenue: number;
};

export function buildDashboardWeeklyInsights(input: BuildDashboardInsightsInput): DashboardInsight[] {
  const {
    revenueByWeek,
    uninvoicedWip,
    pendingLiability,
    topUnbilledCustomer,
    awaitingReviewCount,
    resubmittedCount,
    pendingExpenseCount,
    missingNumberCount,
    openBugCount,
    totalActionItems,
    mtdRevenue,
  } = input;

  const insights: DashboardInsight[] = [];

  // —— Chart weeks (last bar = most recent week in chart) ——
  if (revenueByWeek.length >= 1) {
    const latest = revenueByWeek[revenueByWeek.length - 1];
    if (latest.profit < 0) {
      insights.push({
        id: 'chart-week-loss',
        tone: 'attention',
        title: `Latest chart week in the red (${latest.week})`,
        detail: `Revenue ${fmtMoney(latest.revenue)} vs cost ${fmtMoney(latest.totalCost)} on the weekly chart (ticket-week revenue vs mixed costs). Review Project Profitability for project-level detail.`,
        actionLabel: 'Profitability',
        actionPath: '/profitability',
      });
    } else if (latest.revenue > 0 && latest.profit / latest.revenue >= 0.18) {
      insights.push({
        id: 'chart-week-margin',
        tone: 'positive',
        title: `Solid margin in the latest chart week (${latest.week})`,
        detail: `Roughly ${((latest.profit / latest.revenue) * 100).toFixed(0)}% margin on that bar (${fmtMoney(latest.profit)} on ${fmtMoney(latest.revenue)}).`,
      });
    }
  }

  if (revenueByWeek.length >= 2) {
    const a = revenueByWeek[revenueByWeek.length - 2];
    const b = revenueByWeek[revenueByWeek.length - 1];
    const pr = pctChange(b.revenue, a.revenue);
    const pp = pctChange(b.profit, a.profit);
    if (pr != null && Math.abs(pr) >= 5) {
      insights.push({
        id: 'chart-wow-revenue',
        tone: pr < 0 ? 'neutral' : 'positive',
        title: pr < 0 ? 'Weekly chart: revenue cooled' : 'Weekly chart: revenue accelerated',
        detail: `Bar revenue moved from ${fmtMoney(a.revenue)} (${a.week}) to ${fmtMoney(b.revenue)} (${b.week}), about ${pr >= 0 ? '+' : ''}${pr.toFixed(0)}%.`,
      });
    }
    if (pp != null && b.profit > 0 && a.profit > 0 && Math.abs(pp) >= 15) {
      insights.push({
        id: 'chart-wow-profit',
        tone: pp > 0 ? 'positive' : 'neutral',
        title: pp > 0 ? 'Weekly chart: profit improved' : 'Weekly chart: profit eased',
        detail: `Bar profit went from ${fmtMoney(a.profit)} to ${fmtMoney(b.profit)} week over week (${pp >= 0 ? '+' : ''}${pp.toFixed(0)}%).`,
      });
    }
  }

  // —— WIP & customers ——
  if (uninvoicedWip >= 40_000) {
    insights.push({
      id: 'wip-high',
      tone: 'attention',
      title: 'Large uninvoiced WIP',
      detail: `${fmtMoney(uninvoicedWip)} sits on submitted tickets without invoice numbers—cash and clarity improve when these are numbered and sent.`,
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets?overview=open&tab=submitted',
    });
  } else if (uninvoicedWip > 0 && uninvoicedWip < 8_000) {
    insights.push({
      id: 'wip-low',
      tone: 'positive',
      title: 'Uninvoiced WIP is contained',
      detail: `Only ${fmtMoney(uninvoicedWip)} remains on tickets without numbers—pipeline looks tight.`,
    });
  } else if (uninvoicedWip > 0) {
    insights.push({
      id: 'wip-mid',
      tone: 'neutral',
      title: 'Uninvoiced WIP',
      detail: `${fmtMoney(uninvoicedWip)} on tickets still waiting for invoice numbers.`,
      actionLabel: 'Review tickets',
      actionPath: '/service-tickets',
    });
  }

  if (topUnbilledCustomer && topUnbilledCustomer.value >= 5_000) {
    insights.push({
      id: 'top-unbilled-customer',
      tone: topUnbilledCustomer.value >= 25_000 ? 'attention' : 'neutral',
      title: topUnbilledCustomer.value >= 25_000 ? 'One customer dominates unbilled WIP' : 'Largest unbilled customer',
      detail: `${topUnbilledCustomer.name}: about ${fmtMoney(topUnbilledCustomer.value)} without an invoice number yet.`,
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets',
    });
  }

  if (pendingLiability >= 1_000) {
    insights.push({
      id: 'pending-liability',
      tone: 'attention',
      title: 'Pending receipt liability',
      detail: `${fmtMoney(pendingLiability)} in employee-submitted receipts still pending approval—approve or return to close the loop.`,
      actionLabel: 'Expenses',
      actionPath: '/expenses?overview=open&tab=pending',
    });
  }

  // —— Queues & data quality ——
  if (totalActionItems >= 10) {
    insights.push({
      id: 'action-backlog',
      tone: 'attention',
      title: 'Heavy admin backlog',
      detail: `${totalActionItems} open action items across tickets, expenses, projects, and bugs. Triage the dashboard cards above to unblock the team.`,
    });
  } else if (totalActionItems === 0) {
    insights.push({
      id: 'action-clear',
      tone: 'positive',
      title: 'Action queue is clear',
      detail: 'No tickets awaiting numbering, pending receipt batches, missing project numbers, or open bugs in the counts we track.',
    });
  }

  if (awaitingReviewCount > 0) {
    insights.push({
      id: 'awaiting-review',
      tone: awaitingReviewCount >= 5 ? 'attention' : 'neutral',
      title: `${awaitingReviewCount} ticket${awaitingReviewCount !== 1 ? 's' : ''} awaiting review`,
      detail: 'Submitted tickets still need a ticket / invoice number before they leave WIP.',
      actionLabel: 'Review queue',
      actionPath: '/service-tickets?overview=open&tab=submitted',
    });
  }

  if (resubmittedCount > 0) {
    insights.push({
      id: 'resubmitted',
      tone: 'attention',
      title: `${resubmittedCount} resubmitted ticket${resubmittedCount !== 1 ? 's' : ''}`,
      detail: 'Previously rejected tickets are back in the workflow—worth a quick pass so billing is not delayed.',
      actionLabel: 'Service tickets',
      actionPath: '/service-tickets?overview=open&tab=submitted',
    });
  }

  if (pendingExpenseCount > 0) {
    insights.push({
      id: 'pending-receipts',
      tone: 'neutral',
      title: `${pendingExpenseCount} pending expense approval${pendingExpenseCount !== 1 ? 's' : ''}`,
      detail: 'Employee receipts waiting in the expenses queue.',
      actionLabel: 'Expenses',
      actionPath: '/expenses?overview=open&tab=pending',
    });
  }

  if (missingNumberCount > 0) {
    insights.push({
      id: 'missing-project-numbers',
      tone: 'attention',
      title: `${missingNumberCount} active project${missingNumberCount !== 1 ? 's' : ''} missing job numbers`,
      detail: 'Projects without numbers are harder to match on tickets and reports.',
      actionLabel: 'Projects',
      actionPath: '/projects?overview=open&missing=1',
    });
  }

  if (openBugCount > 0) {
    insights.push({
      id: 'open-bugs',
      tone: 'neutral',
      title: `${openBugCount} open bug report${openBugCount !== 1 ? 's' : ''}`,
      detail: 'Track software issues reported from the field or office.',
      actionLabel: 'Bugs',
      actionPath: '/service-tickets?overview=open&tab=submitted',
    });
  }

  // —— MTD ——
  if (mtdRevenue > 0) {
    insights.push({
      id: 'mtd',
      tone: 'neutral',
      title: 'Month-to-date ticket revenue',
      detail: `${fmtMoney(mtdRevenue)} from approved-path tickets dated this month (pre-GST in this rollup; see Employee Reports if you use GST-inclusive views).`,
      actionLabel: 'Employee reports',
      actionPath: '/employee-reports',
    });
  }

  return sortInsights(insights);
}
