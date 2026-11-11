const VALUE_PREFIX = 'mppx-json:'
const EMPTY_VALUE = '__mppx_empty__'
const DELETE_VALUE = '__mppx_delete__'
const MAX_UPDATE_ATTEMPTS = 32

const compareAndSwap = `
local current = redis.call('GET', KEYS[1])
if (current or '__mppx_empty__') ~= ARGV[1] then
  return 0
end
if ARGV[3] == 'delete' then
  redis.call('DEL', KEYS[1])
elseif tonumber(ARGV[4]) and tonumber(ARGV[4]) > 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[4])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
return 1
`

function expirationMilliseconds(value) {
  if (value && value.type === 'mppx:replay' && Number.isFinite(value.expires)) {
    return Math.max(1, Math.ceil(value.expires - Date.now()))
  }
  return undefined
}

function encode(value, Json) {
  return VALUE_PREFIX + Buffer.from(Json.stringify(value), 'utf8').toString('base64')
}

function decode(value, Json) {
  if (value === null) return null
  if (typeof value !== 'string' || !value.startsWith(VALUE_PREFIX)) {
    throw new Error('Unexpected value found in the MPP replay-protection store.')
  }
  return Json.parse(Buffer.from(value.slice(VALUE_PREFIX.length), 'base64').toString('utf8'))
}

export function createReplayStore(redis, Json) {
  return {
    async get(key) {
      return decode(await redis.get(key), Json)
    },
    async set(key, value) {
      const encoded = encode(value, Json)
      const px = expirationMilliseconds(value)
      if (px) await redis.set(key, encoded, { px })
      else await redis.set(key, encoded)
    },
    async del(key) {
      await redis.del(key)
    },
    async update(key, fn) {
      for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
        const currentEncoded = await redis.get(key)
        const current = decode(currentEncoded, Json)
        const change = fn(current)

        if (change.op === 'noop') return change.result

        const deletion = change.op === 'delete'
        const nextEncoded = deletion ? DELETE_VALUE : encode(change.value, Json)
        const px = deletion ? undefined : expirationMilliseconds(change.value)
        const applied = await redis.eval(compareAndSwap, [key], [
          currentEncoded === null ? EMPTY_VALUE : currentEncoded,
          nextEncoded,
          deletion ? 'delete' : 'set',
          px ? String(px) : ''
        ])

        if (Number(applied) === 1) return change.result
        if (attempt + 1 < MAX_UPDATE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 100)))
        }
      }

      throw new Error(`MPP replay-store update for "${key}" conflicted ${MAX_UPDATE_ATTEMPTS} times.`)
    }
  }
}
