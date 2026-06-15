self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Handleliste', body: 'Ny vare lagt til' };
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/shopping/icon.png'
  }));
});
