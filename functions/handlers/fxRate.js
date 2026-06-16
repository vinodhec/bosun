import { onSchedule } from 'firebase-functions/v2/scheduler';
import { refreshFxRate } from '../utils/fxRate.js';

// Pull the live USD->INR rate once a day and cache it in config/fxRate so billing converts COGS
// at a current rate instead of a stale constant (see utils/fxRate.js). A failed fetch is a no-op:
// billing keeps using the last good cached value (or DEFAULT_USD_TO_INR if none has landed yet).
export const refreshExchangeRate = onSchedule(
  { region: 'asia-south1', schedule: 'every day 00:00', timeZone: 'Asia/Kolkata' },
  async () => {
    await refreshFxRate();
  },
);
