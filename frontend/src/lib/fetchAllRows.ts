/**
 * PostgREST caps every response at a fixed number of rows (Supabase's default is 1000)
 * and truncates *silently* — no error, no flag on the response. Any query that can return
 * more rows than that will quietly hand back partial data, and callers have no way to tell.
 *
 * This bit the Service Tickets page once `service_tickets` crossed 1000 rows: three approved
 * tickets fell outside the response, the page could not match them to their time entries, and
 * they reappeared as un-approvable drafts. Route every list query over a growing table through
 * `fetchAllRows`.
 */

/**
 * Must match the project's PostgREST "Max Rows" setting (Supabase dashboard → Settings → API).
 * If that setting is ever lowered, lower this too — paging assumes a short page means the last
 * page, so a server cap below PAGE_SIZE would silently truncate again.
 */
export const SUPABASE_MAX_ROWS = 1000;

/** The subset of the Supabase query builder that paging needs. */
type PagedQuery<T> = {
  order: (column: string, opts: { ascending: boolean }) => PagedQuery<T>;
  range: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
};

/**
 * Run a Supabase select in pages and return every row.
 *
 * Takes a *factory* rather than a query: a Supabase query builder executes once, so each page
 * needs a freshly built one. Call it exactly as you would have called the query itself:
 *
 *   const rows = await fetchAllRows(() =>
 *     supabase.from('service_tickets').select('*').gte('date', startDate)
 *   );
 *
 * A unique tiebreaker column is appended to whatever ordering the caller set. Without a total
 * order Postgres is free to return rows in a different sequence per page, which duplicates some
 * rows across pages and drops others entirely — a subtler version of the bug this exists to fix.
 *
 * @param makeQuery   Builds a fresh query. Do not call `.range()` on it yourself.
 * @param tiebreakColumn Unique column used to make the ordering total. Defaults to `id`; pass the
 *                       primary key for tables that use something else (e.g. `group_id`).
 */
export async function fetchAllRows<T>(
  makeQuery: () => PagedQuery<T>,
  tiebreakColumn: string = 'id'
): Promise<T[]> {
  const all: T[] = [];

  for (let offset = 0; ; offset += SUPABASE_MAX_ROWS) {
    const { data, error } = await makeQuery()
      .order(tiebreakColumn, { ascending: true })
      .range(offset, offset + SUPABASE_MAX_ROWS - 1);

    if (error) throw error;

    const page = data ?? [];
    all.push(...page);

    // A page shorter than the requested window is the last one.
    if (page.length < SUPABASE_MAX_ROWS) return all;
  }
}
