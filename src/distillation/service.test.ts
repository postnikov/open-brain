import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createDistillationService } from './service.js'
import { bin, startFixture } from './test-fixture.js'
import { RetryStore } from './retry-store.js'
import type { CapturePipeline } from '../pipeline/capture.js'
import { createCapturePipeline } from '../pipeline/capture.js'
import { createEmbeddingService } from '../pipeline/embeddings.js'
import { createMetadataService } from '../pipeline/metadata.js'
const { completionsCreate, embeddingsCreate }=vi.hoisted(()=>({completionsCreate:vi.fn(),embeddingsCreate:vi.fn()}))
vi.mock('openai',()=>({default:class{chat={completions:{create:completionsCreate}};embeddings={create:embeddingsCreate}}}))
const config={model:'gpt-4o-mini',temperature:0.3,maxBlocksPerRun:50,minBlockLength:20}
const response=(thoughts:unknown[])=>({choices:[{message:{content:JSON.stringify({thoughts})}}],usage:{total_tokens:1000,prompt_tokens:800,completion_tokens:200}})
const thoughts=[{content:'First retained thought',content_type:'insight'},{content:'Second failed thought',content_type:'decision'}]

describe.skipIf(!bin)('production distillation service — real PostgreSQL, fake AI',()=>{
  let fixture:Awaited<ReturnType<typeof startFixture>>
  beforeAll(async()=>{fixture=await startFixture()},20_000)
  afterAll(async()=>{await fixture?.close()},20_000)
  beforeEach(()=>completionsCreate.mockReset())
  async function setup(content='A sufficiently long stream block for production service testing.'){
    const db=await fixture.database()
    const block=await db.stream.write({sessionId:'synthetic',blockNumber:0,content},30)
    const prepare=vi.fn(async(input:any)=>({...input,title:'Synthetic'}))
    const capture=vi.fn(async()=>{throw new Error('Legacy capture must never be used')})
    const pipeline={prepare,capture} as CapturePipeline
    const make=()=>createDistillationService(db.stream,pipeline,db.logs,config,'fake-key',db.store)
    return {...db,block,prepare,capture,make,service:make()}
  }
  it('release gate: mixed failure retains input and does not report success',async()=>{
    const x=await setup();completionsCreate.mockResolvedValueOnce(response(thoughts))
    const markDistilled=vi.spyOn(x.stream,'markDistilled')
    x.prepare.mockImplementation(async input=>{if(input.content.startsWith('Second'))throw new Error('metadata enum request/recommendation');return {...input,title:'Synthetic'}})
    const result=await x.service.run('manual')
    expect.soft(result.status).toBe('partial');expect(markDistilled).not.toHaveBeenCalled()
    expect((await x.stream.findBySession('synthetic',10))[0]!.distilledAt).toBeNull()
    const items=(await x.pool.query('SELECT * FROM distillation_retry_items ORDER BY item_index')).rows
    expect(items.filter(i=>i.thought_id)).toHaveLength(1)
    x.prepare.mockImplementation(async input=>({...input,title:'Synthetic'}))
    const resumed=await x.make().run('retry')
    expect(resumed.status).toBe('success');expect(resumed.thoughtsCreated).toBe(2)
    expect(completionsCreate).toHaveBeenCalledOnce();expect(x.capture).not.toHaveBeenCalled()
    expect(resumed.tokensUsed).toBe(1000)
    expect(resumed.estimatedCost).toBeCloseTo(0.00024,6)
    expect((await x.pool.query('SELECT count(*)::int n FROM thoughts')).rows[0].n).toBe(2)
    expect((await x.pool.query('SELECT sum(thoughts_created)::int n FROM distillation_log')).rows[0].n).toBe(2)
    expect((await x.pool.query('SELECT thought_id FROM distillation_retry_items ORDER BY item_index')).rows[0].thought_id).toBe(items[0].thought_id)
  })
  it('short and valid empty extraction terminate successfully',async()=>{
    for(const content of ['short','Long source block with nothing worth retaining']){
      const x=await setup(content);completionsCreate.mockResolvedValue(response([]))
      const result=await x.service.run('manual');expect(result.status).toBe('success')
      expect((await x.stream.findBySession('synthetic',1))[0]!.distilledAt).not.toBeNull()
    }
    expect(completionsCreate).toHaveBeenCalledOnce()
  })
  it('quota and invalid extraction retain source, persist backoff and expose blocked state',async()=>{
    for(const mode of ['quota','invalid']){
      const x=await setup();const store=new RetryStore(x.pool,{baseDelayMs:1000,maxDelayMs:2000,maxAttempts:2})
      const service=createDistillationService(x.stream,{prepare:x.prepare,capture:x.capture},x.logs,config,'fake',store)
      if(mode==='quota')completionsCreate.mockRejectedValue(new Error('429'))
      else completionsCreate.mockResolvedValue(response([{content:'invalid',content_type:'request'}]))
      await expect(service.run('manual')).rejects.toThrow('retained')
      const job=(await store.status())[0]!
      expect(job.attempts).toBe(1);expect(job.blocked).toBe(false)
      expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
      expect((await service.run('retry')).blocksProcessed).toBe(0)
      await x.pool.query("UPDATE distillation_retry_jobs SET next_attempt_at=now()-interval '1 second'")
      await expect(service.run('retry')).rejects.toThrow('retained')
      expect((await store.status())[0]!.blocked).toBe(true)
      expect((await x.stream.findBySession('synthetic',1))[0]!.distilledAt).toBeNull()
      expect((await x.pool.query('SELECT count(*)::int n FROM distillation_ai_calls')).rows[0].n).toBe(2)
    }
  })
  it('TTL retains pending, reserved and legacy-distilled input, deletes only durable completed input',async()=>{
    const x=await setup();await x.pool.query("UPDATE stream SET expires_at=now()-interval '1 day'")
    expect(await x.stream.cleanupExpired()).toBe(0)
    await expect(x.stream.deleteById(x.block.id)).rejects.toThrow()
    await x.pool.query('UPDATE stream SET distilled_at=now()')
    expect(await x.stream.cleanupExpired()).toBe(0)
    await x.pool.query('UPDATE stream SET distilled_at=NULL')
    await x.store.reserveNext(50,config)
    expect(await x.stream.cleanupExpired()).toBe(0)
    await expect(x.stream.pin(x.block.id)).rejects.toThrow()
    completionsCreate.mockResolvedValue(response(thoughts));expect((await x.service.run('manual')).status).toBe('success')
    expect(await x.stream.cleanupExpired()).toBe(1)
    expect((await x.pool.query('SELECT count(*)::int n FROM thoughts')).rows[0].n).toBe(2)
    expect((await x.pool.query('SELECT input_snapshot FROM distillation_retry_jobs')).rows[0].input_snapshot[0].content).toBe(x.block.content)
  })
  it('identical upsert is idempotent; changed content requires a new block number',async()=>{
    const x=await setup();const same=await x.stream.write({sessionId:'synthetic',blockNumber:0,content:x.block.content},30)
    expect(same.id).toBe(x.block.id)
    await expect(x.stream.write({sessionId:'synthetic',blockNumber:0,content:'changed'},30)).rejects.toThrow()
    expect((await x.stream.write({sessionId:'synthetic',blockNumber:1,content:'correction'},30)).id).not.toBe(x.block.id)
  })
  it('concurrent services share one durable job and cannot duplicate effects',async()=>{
    const x=await setup();completionsCreate.mockResolvedValue(response(thoughts))
    await Promise.all([x.service.run('manual'),x.make().run('cli')])
    expect((await x.pool.query('SELECT count(*)::int n FROM distillation_retry_jobs')).rows[0].n).toBe(1)
    expect((await x.pool.query('SELECT count(*)::int n FROM thoughts')).rows[0].n).toBe(2)
    expect(completionsCreate).toHaveBeenCalledOnce()
  })
  it('retry timer never selects fresh historical input',async()=>{
    const x=await setup();expect((await x.service.run('retry')).blocksProcessed).toBe(0)
    expect(completionsCreate).not.toHaveBeenCalled()
    expect((await x.pool.query('SELECT count(*)::int n FROM distillation_retry_jobs')).rows[0].n).toBe(0)
  })
  it('accounts for embedding and invalid metadata responses, including retried preparation',async()=>{
    const x=await setup()
    const repository={create:vi.fn()}
    const pipeline=createCapturePipeline(createEmbeddingService('fake','text-embedding-3-small'),createMetadataService('fake','gpt-4o-mini'),repository as any)
    embeddingsCreate.mockResolvedValue({data:[{embedding:Array(1536).fill(0)}],usage:{total_tokens:10,prompt_tokens:10}})
    completionsCreate.mockResolvedValueOnce(response([thoughts[0]]))
      .mockResolvedValueOnce({choices:[{message:{content:'{"content_type":"request"}'}}],usage:{total_tokens:30,prompt_tokens:20,completion_tokens:10}})
      .mockResolvedValueOnce({choices:[{message:{content:JSON.stringify({title:'Synthetic title',content_type:'note',tags:['test'],topics:['fixture'],sentiment:'neutral'})}}],usage:{total_tokens:30,prompt_tokens:20,completion_tokens:10}})
    const service=createDistillationService(x.stream,pipeline,x.logs,config,'fake',x.store)
    expect((await service.run('manual')).status).toBe('partial')
    const result=await service.run('retry');expect(result.status).toBe('success');expect(result.tokensUsed).toBe(1080)
    expect((await x.pool.query('SELECT phase,count(*)::int n FROM distillation_ai_calls GROUP BY phase ORDER BY phase')).rows).toEqual([
      {phase:'embedding',n:2},{phase:'extraction',n:1},{phase:'metadata',n:2},
    ])
    expect(repository.create).not.toHaveBeenCalled()
  })
  it('bounded attempts also stop repeatedly crashed workers',async()=>{
    const x=await setup(), store=new RetryStore(x.pool,{baseDelayMs:0,maxDelayMs:0,maxAttempts:1})
    const id=(await store.reserveNext(50,config))!
    expect(await store.claim(id,60_000)).not.toBeNull()
    await x.pool.query("UPDATE distillation_retry_jobs SET lease_until=now()-interval '1 second'")
    expect(await store.claim(id,60_000)).toBeNull()
    expect((await store.status())[0]!.blocked).toBe(true)
  })
})
