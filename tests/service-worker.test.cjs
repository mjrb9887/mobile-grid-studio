const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function worker(){
  const handlers={},stored=new Map([['./index.html',{version:'offline'}]]),deleted=[];
  let fetched=0,skipped=false,claimed=false,mode='online';
  const cache={addAll:async()=>{},match:async key=>stored.get(key),put:async(key,response)=>stored.set(key,response)};
  const self={location:{origin:'https://example.com'},clients:{claim:async()=>{claimed=true}},skipWaiting:async()=>{skipped=true},addEventListener:(event,fn)=>handlers[event]=fn};
  const context=vm.createContext({URL,self,caches:{open:async()=>cache,keys:async()=>['grid-studio-v11','grid-studio-v12','grid-studio-v13','other-app'],delete:async key=>deleted.push(key)},fetch:async()=>{fetched++;if(mode==='offline')throw new Error('offline');return {ok:mode==='online',version:'latest',clone(){return {version:'latest'}}}}});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8'),context);
  return {handlers,stored,deleted,setMode:value=>mode=value,fetched:()=>fetched,skipped:()=>skipped,claimed:()=>claimed};
}
test('updated worker activates immediately, claims pages and deletes only its older caches',async()=>{
  const w=worker();let done;w.handlers.install({waitUntil:p=>done=p});await done;assert(w.skipped());
  w.handlers.activate({waitUntil:p=>done=p});await done;assert(w.claimed());assert.deepEqual(w.deleted,['grid-studio-v11','grid-studio-v12']);
});
test('navigation refreshes an old cached page and updates its offline copy',async()=>{
  const w=worker();let done;w.handlers.fetch({request:{method:'GET',mode:'navigate',url:'https://example.com/index.html'},respondWith:p=>done=p});
  const response=await done;assert.equal(response.version,'latest');assert.equal(w.stored.get('./index.html').version,'latest');assert.equal(w.fetched(),1);
});
test('offline or unsuccessful navigation preserves the last successful page',async()=>{
  for(const mode of ['offline','failure']){const w=worker();w.setMode(mode);let done;w.handlers.fetch({request:{method:'GET',mode:'navigate',url:'https://example.com/?v=new'},respondWith:p=>done=p});assert.equal((await done).version,'offline')}
});
test('external requests and writes are not intercepted',()=>{
  const w=worker();for(const request of [{method:'POST',url:'https://example.com/'},{method:'GET',url:'https://other.example/'}]){w.handlers.fetch({request,respondWith(){assert.fail('Unexpected interception')}})}
});
