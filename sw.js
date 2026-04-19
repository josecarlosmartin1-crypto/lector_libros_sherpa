// sw.js - Service Worker minimalista para habilitar PWA
const CACHE_NAME = 'voxepub-v13';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Pass-through simple para permitir el funcionamiento normal
    // mientras se cumple el requisito de instalación.
    event.respondWith(fetch(event.request));
});
