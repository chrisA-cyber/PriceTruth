// Durable, leased, idempotent job worker. Jobs survive restarts in the same
// database; expired leases can be reclaimed, and exponential retry is handled
// by the database adapter. Call tick() from an interval or a dedicated process.
function createJobWorker(db, handlers = {}, { batchSize = 10 } = {}) {
  let running = false;
  async function tick() {
    if (running) return [];
    running = true;
    const results = [];
    try {
      for (const job of await db.claimJobs(batchSize)) {
        try {
          const handler = handlers[job.type];
          if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
          const payload = JSON.parse(job.payload_json);
          await handler(payload, job);
          const completed = await db.completeJob(job.id, job.lease_token || null);
          results.push({ id: job.id, status: completed ? 'completed' : 'canceled' });
        } catch (error) {
          const failed = await db.failJob(job.id, error.message, job.lease_token || null);
          results.push({ id: job.id, status: failed ? 'failed' : 'canceled', ...(failed ? { error: error.message } : {}) });
        }
      }
      return results;
    } finally {
      running = false;
    }
  }
  return { tick };
}

export { createJobWorker };
