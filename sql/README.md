# SQL layout

| Path | Purpose |
|------|---------|
| `migrations/` | Versioned `migration_*.sql` files applied by `apply-migrations.js` (repo root). Paths are `sql/migrations/<filename>`. |
| `scripts/` | One-off maintenance / diagnosis SQL run manually in Supabase SQL Editor. See `../scripts/README.md`. |
| `supabase-schema.sql` | Reference schema snapshot for docs / setup (not auto-applied by the app at runtime). |
| `supabase-dev-user.sql` | Optional dev seed (manual). |

**`supabase/migrations/`** (at repo root) is used by **Supabase CLI** remote migration history. It may overlap names with `sql/migrations/`; treat CLI-tracked files as source of truth for what Supabase has applied remotely.

**Runtime:** The app does not execute these files on each request. Only migration runners / manual runs use them.
