// Tombstone service worker.
//
// Bosun does not use a service worker. An old one was registered on this origin
// and browsers that still have it keep intercepting requests (and failing). A
// service worker can only be removed by a service worker, so this file exists
// solely to unregister itself, drop every cache it left behind, and reload the
// page onto the real network. It has no fetch handler — nothing is intercepted.
//
// Safe to delete once the installed base has cycled through it.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();

      const windows = await self.clients.matchAll({ type: 'window' });
      windows.forEach((client) => client.navigate(client.url));
    })()
  );
});
