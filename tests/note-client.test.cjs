const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {NoteClient}=require('../src/services/note-client.cjs');
test('connecting loads snapshot and refuses unauthenticated mutation without local success',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-client-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let seenAuth;const server=http.createServer((req,res)=>{seenAuth=req.headers.authorization;if(req.url==='/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: snapshot\ndata: '+JSON.stringify({revision:2,data:{items:[{id:'a',text:'已有任务',status:'todo'}]}})+'\n\n');return;}if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revision:2,data:{items:[{id:'a',text:'已有任务',status:'todo'}]}}));}else{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'桥接令牌已失效'}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});fs.writeFileSync(path.join(dir,'pet-bridge.json'),JSON.stringify({version:1,port:server.address().port,token:'test-token',pid:process.pid}));const client=new NoteClient({dataDir:dir});t.after(()=>client.close());await client.connect();assert.equal(client.snapshot().items[0].text,'已有任务');assert.equal(seenAuth,'Bearer test-token');await assert.rejects(client.createTask({text:'不能伪报保存'}),/令牌/);assert.equal(client.snapshot().items.length,1);});

test('late HTTP receipt cannot roll back a newer SSE task snapshot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-client-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let eventResponse;
  let releaseUpdate;
  let reportSubscribed;
  const subscribed = new Promise(resolve => { reportSubscribed = resolve; });
  const snapshot = (revision, text) => ({ revision, data: { items: [{ id: 'a', text, status: 'todo' }] } });
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/events') {
      eventResponse = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: snapshot\ndata: ' + JSON.stringify(snapshot(1, '初始')) + '\n\n');
      reportSubscribed();
    } else if (req.method === 'PATCH') {
      releaseUpdate = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ item: { id: 'a', text: '旧回执' }, snapshot: snapshot(2, '旧回执') }));
      };
      eventResponse.write('event: state\ndata: ' + JSON.stringify(snapshot(3, '较新的修改')) + '\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshot(1, '初始')));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  fs.writeFileSync(path.join(dir, 'pet-bridge.json'), JSON.stringify({ version: 1, port: server.address().port, token: 'order-token', pid: process.pid }));
  const client = new NoteClient({ dataDir: dir });
  t.after(() => client.close());
  await client.connect();
  await subscribed;
  const newer = new Promise(resolve => client.on('state', state => { if (state.revision === 3) resolve(); }));
  const update = client.updateTask('a', { text: '旧回执' });
  await newer;
  releaseUpdate();
  await update;
  assert.equal(client.snapshot().revision, 3);
  assert.equal(client.snapshot().items[0].text, '较新的修改');
});
