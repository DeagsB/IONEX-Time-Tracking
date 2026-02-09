-- Track when a ticket was rejected so we can show resubmitted tickets at top with highlight on Submitted tab
ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.service_tickets_demo
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.service_tickets.rejected_at IS 'Set when admin rejects; cleared when admin approves (assigns ticket number). Used to show resubmitted tickets at top with highlight.';
COMMENT ON COLUMN public.service_tickets_demo.rejected_at IS 'Set when admin rejects; cleared when admin approves.';
