// Re-export the canonical gamification logic (synced into ./shared at predeploy by
// scripts/sync-shared.sh). Single source of truth lives in /shared/gamification.js.
// PURE + money-free — see that file. Keep this thin; never fork the logic here.
export * from '../shared/gamification.js';
