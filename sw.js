const CACHE='grid-studio-v14';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon.svg','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(
  caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())
));
self.addEventListener('activate',event=>event.waitUntil(
  caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key.startsWith('grid-studio-')&&key!==CACHE).map(key=>caches.delete(key))
  )).then(()=>self.clients.claim())
));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
  // Refresh pages from the network, retaining the last successful page for offline use.
  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      try{
        const response=await fetch(request,{cache:'no-cache'});
        if(response.ok){await cache.put('./index.html',response.clone());return response}
        const offline=await cache.match('./index.html');return offline||response;
      }catch(error){const offline=await cache.match('./index.html');if(offline)return offline;throw error}
    })());
    return;
  }
  event.respondWith(caches.open(CACHE).then(async cache=>
    (await cache.match(request))||fetch(request)
  ));
});
