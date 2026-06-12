// ============================================================================
// LibreOffice invocation queue
//
// Serializes ALL soffice spawns process-wide (concurrency = 1). A single
// LibreOffice process can use 300+ MB of RAM; two running at once will OOM
// Render's 512 MB free tier. Every service that shells out to soffice must
// wrap the call in withLibreOfficeLock().
// ============================================================================

let tail = Promise.resolve();
let depth = 0;

/**
 * Run `task` once all previously queued LibreOffice jobs have finished.
 * Returns task's own promise (rejections propagate to the caller but never
 * break the queue chain).
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withLibreOfficeLock(task) {
  depth += 1;
  // `tail` never rejects (see below), so a single fulfillment handler is safe.
  const run = tail.then(task).finally(() => {
    depth -= 1;
  });
  tail = run.catch(() => {});
  return run;
}

/** Number of jobs queued or running (0 = idle). */
function queueDepth() {
  return depth;
}

module.exports = { withLibreOfficeLock, queueDepth };
