self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(async clients => {
    const target = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (target) return target.focus();
    return self.clients.openWindow('./');
  }));
});
