import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { describe, expect, it } from 'vitest';
import { HindsightMemory } from '../core/memory/hindsight.ts';
import { loadHindsightConfig } from '../core/memory/config.ts';
import { MemoryOutbox } from '../core/memory/outbox.ts';
import { ForgetLedger } from '../core/memory/forget-ledger.ts';
import { closeMemoryStateStores, openMemoryStateStore } from '../core/memory/state-store.ts';

describe('recall failure scope', () => {
  for (const serviceFailure of [false, true]) {
    it(serviceFailure
      ? 'backs off after an actual service error instead of immediately repeating requests'
      : 'allows the next recall after a single query exceeds its own deadline', async () => {
      const root=mkdtempSync(join(tmpdir(),'coo-recall-cooldown-'));
      let requests=0;
      const server=createServer((req,res)=>{
        req.resume();req.once('end',()=>{
          requests++;
          if(requests===1 && serviceFailure){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({detail:'Fixture service unavailable.'}));return;}
          const send=()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({results:[{id:'fixture-fact',document_id:'fixture-source',type:'world',text:'The fixture marker is amber.',metadata:{source_actor:'user',kind:'event'}}]}));};
          if(requests===1)setTimeout(send,180);else send();
        });
      });
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const store=openMemoryStateStore(join(root,'state.sqlite')),outbox=new MemoryOutbox(store),ledger=new ForgetLedger(store),memory=new HindsightMemory();
      Object.assign(memory,{config:loadHindsightConfig(root,{enabled:true,autostart:false,apiUrl:baseUrl,bankId:'fixture-bank'}),client:new HindsightClient({baseUrl,maxAttempts:1}),stateStore:store,outbox,ledger,ready:true,unavailableUntil:0});
      try{
        const first=await memory.recallBlockDetailed('What marker?',{timeoutMs:90});
        expect(first.status).toBe('unavailable');
        const second=await memory.recallBlockDetailed('What marker now?',{timeoutMs:1000});
        expect(second.status).toBe(serviceFailure?'unavailable':'found');
        expect(second.text.includes('amber')).toBe(!serviceFailure);
        if(serviceFailure)expect(requests).toBe(1);
      }finally{
        await new Promise<void>(resolve=>server.close(()=>resolve()));
        closeMemoryStateStores();rmSync(root,{recursive:true,force:true});
      }
    });
  }
});
