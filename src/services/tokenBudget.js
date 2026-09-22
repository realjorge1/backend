// ============================================
// FILE: services/tokenBudget.js
// Per-user token accounting for the optional DAILY_TOKEN_BUDGET_PER_USER cap.
// Counters live in this instance's memory and reset at UTC midnight.
// ============================================
const apiConfig = require("../config/apiConfig");

const usage = new Map(); // `${utcDay}:${userHash}` -> tokens

function today() {
  return new Date().toISOString().slice(0, 10);
}

function keyFor(userHash) {
  return `${today()}:${userHash}`;
}

function record(userHash, tokens) {
  if (!userHash || !tokens) return;
  const key = keyFor(userHash);
  usage.set(key, (usage.get(key) || 0) + tokens);
}

function usedToday(userHash) {
  if (!userHash) return 0;
  return usage.get(keyFor(userHash)) || 0;
}

function isOverBudget(userHash) {
  const budget = apiConfig.dailyTokenBudgetPerUser;
  if (!budget || !userHash) return false;
  return usedToday(userHash) >= budget;
}

/** Drop counters from previous days. */
function purge() {
  const prefix = `${today()}:`;
  for (const key of usage.keys()) {
    if (!key.startsWith(prefix)) usage.delete(key);
  }
}

const purgeTimer = setInterval(purge, 60 * 60 * 1000);
purgeTimer.unref();

module.exports = { record, usedToday, isOverBudget, purge, _usage: usage };
