import test from 'node:test'
import assert from 'node:assert/strict'
import { Json } from 'ox'
import { createReplayStore } from '../src/replay-store.js'

function createMemoryRedis() {
  const values = new Map()
  return {
    values,
    async get(key) {
      return values.get(key) ?? null
    },
    async set(key, value) {
      values.set(key, value)
    },
    async del(key) {
      values.delete(key)
    },
    async eval(_script, [key], [expected, next, operation]) {
      const current = values.get(key) ?? '__mppx_empty__'
      if (current !== expected) return 0
      if (operation === 'delete') values.delete(key)
      else values.set(key, next)
      return 1
    }
  }
}

test('round-trips JSON-safe values and BigInts through Upstash encoding', async () => {
  const redis = createMemoryRedis()
  const store = createReplayStore(redis, Json)
  const value = { amount: 12345678901234567890n, nested: { ok: true } }

  await store.set('receipt', value)

  assert.deepEqual(await store.get('receipt'), value)
})

test('updates atomically when concurrent callers race', async () => {
  const store = createReplayStore(createMemoryRedis(), Json)

  await Promise.all(Array.from({ length: 20 }, () => store.update('counter', (current) => ({
    op: 'set',
    value: (current ?? 0) + 1,
    result: true
  }))))

  assert.equal(await store.get('counter'), 20)
})

test('deletes a key atomically and can claim the empty key again', async () => {
  const store = createReplayStore(createMemoryRedis(), Json)
  await store.set('claim', 'first')
  const deleted = await store.update('claim', () => ({ op: 'delete', result: 'deleted' }))

  assert.equal(deleted, 'deleted')
  assert.equal(await store.get('claim'), null)

  const created = await store.update('claim', (current) => ({
    op: 'set',
    value: current ?? 'second',
    result: 'created'
  }))
  assert.equal(created, 'created')
  assert.equal(await store.get('claim'), 'second')
})
