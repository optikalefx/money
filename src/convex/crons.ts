import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Daily refresh of both data sources, staggered so the Gmail import runs after new Plaid charges
// have landed (order↔charge matching prefers a real charge to bind to). Times are UTC: 10:00 UTC
// is 5/6am ET, before the day starts. Every run is recorded in `syncRuns` (source, duration,
// added/modified/removed counts, errors), so the dashboard/UI shows when each service updated and
// how much came in.
crons.cron('daily plaid sync', '0 10 * * *', internal.plaidActions.syncAllItemsInternal, {});
crons.cron('daily gmail sync', '30 10 * * *', internal.gmailActions.syncGmailInternal, {});

export default crons;
