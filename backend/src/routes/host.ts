import { Router } from 'express';
import { capacityReport } from '../services/hostCapacityService';
import { toApiError } from '../apiErrors';

const router = Router();

/**
 * The memory ledger the start gate decides on.
 *
 * Served to the dashboard so the same numbers that refuse a start are visible
 * before anyone presses the button — a limit you can only discover by hitting
 * it is indistinguishable from a bug.
 */
router.get('/capacity', async (_req, res) => {
  try {
    res.json(await capacityReport());
  } catch (err) {
    const apiErr = toApiError(err, { error: 'Failed to read host capacity', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
  }
});

export default router;
