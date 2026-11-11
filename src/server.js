import 'dotenv/config'
import express from 'express'
import { Redis } from '@upstash/redis'
import { Json } from 'ox'
import { fileURLToPath } from 'node:url'
import { Mppx, discovery } from 'mppx/express'
import { Store, tempo } from 'mppx/server'
import { analyzeWebhook, MAX_PAYLOAD_BYTES_LIMIT } from './analyze.js'
import { createReplayStore } from './replay-store.js'

const port = Number(process.env.PORT ?? 4101)
const secretKey = process.env.MPP_SECRET_KEY
const recipient = process.env.MPP_RECIPIENT
const upstashUrl = process.env.UPSTASH_REST_URL
const upstashToken = process.env.UPSTASH_REST_TOKEN
const tempoTestnetPathUsd = '0x20c0000000000000000000000000000000000000'

if (!secretKey) {
  throw new Error('MPP_SECRET_KEY is required. Set it in the server environment; never commit it.')
}

if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
  throw new Error('MPP_RECIPIENT must be a Tempo testnet wallet address (0x followed by 40 hexadecimal characters).')
}

if (Boolean(upstashUrl) !== Boolean(upstashToken)) {
  throw new Error('UPSTASH_REST_URL and UPSTASH_REST_TOKEN must both be configured.')
}

if (process.env.NODE_ENV === 'production' && !upstashUrl) {
  throw new Error('Production requires shared atomic Upstash Redis storage for payment replay protection.')
}

const replayStore = upstashUrl
  ? Store.upstash(createReplayStore(new Redis({ url: upstashUrl, token: upstashToken }), Json))
  : Store.memory()

const app = express()
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))))
const mppx = Mppx.create({
  methods: [tempo.charge({
    currencies: [tempoTestnetPathUsd],
    recipient,
    testnet: true,
    store: replayStore
  })],
  secretKey
})
const paidDebug = mppx.charge({ amount: '0.01', description: 'Stripe webhook diagnostic report' })

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', paymentNetwork: 'tempo-testnet' })
})

app.get('/llms.txt', (_req, res) => {
  res.type('text/plain').send([
    '# Stripe Webhook Debugger',
    '',
    '> Pay-per-use diagnostics for Stripe webhook event payloads.',
    '',
    '## Paid endpoint',
    '',
    '- `POST /api/debug` — costs $0.01 per request in pathUSD on Tempo testnet.',
    '- Submit `rawPayload` (the exact raw Stripe event body), optional `signatureHeader`, and optional `expectedMode` (`test` or `live`).',
    '- Returns structural validation, security/configuration checks, and actionable recommendations for snapshot and thin events.',
    '- Payments are testnet-only; this service does not enable mainnet payments.',
    '',
    '## Privacy and verification limits',
    '',
    '- Do not send webhook signing secrets, Stripe API keys, or other credentials.',
    '- Submitted payloads are analyzed in memory and are not intentionally persisted.',
    '- Signature header format and timestamp are inspected, but the cryptographic signature is not verified by this API.',
    '- Verify signatures in your own webhook handler with the Stripe SDK, endpoint secret, and unmodified raw request body.',
    '',
    '## Discovery',
    '',
    '- `GET /openapi.json` — OpenAPI document with MPP payment offers.'
  ].join('\n'))
})

app.post(
  '/api/debug',
  paidDebug,
  express.json({ limit: '512kb', type: 'application/json' }),
  (req, res) => {
    const body = req.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' })
    }

    const allowedFields = new Set(['rawPayload', 'signatureHeader', 'expectedMode'])
    const unexpectedFields = Object.keys(body).filter((key) => !allowedFields.has(key))
    if (unexpectedFields.length > 0) {
      return res.status(400).json({
        error: 'Unsupported request fields. Do not send webhook signing secrets or Stripe API keys.'
      })
    }

    if (typeof body.rawPayload !== 'string' || body.rawPayload.length === 0) {
      return res.status(400).json({ error: 'rawPayload must be a non-empty string containing the original Stripe event body.' })
    }

    if (Buffer.byteLength(body.rawPayload, 'utf8') > MAX_PAYLOAD_BYTES_LIMIT) {
      return res.status(413).json({ error: 'rawPayload exceeds the 240 KiB analysis limit.' })
    }

    if (body.signatureHeader !== undefined &&
        (typeof body.signatureHeader !== 'string' || body.signatureHeader.length > 4096)) {
      return res.status(400).json({ error: 'signatureHeader must be a string no longer than 4096 characters.' })
    }

    if (body.expectedMode !== undefined && body.expectedMode !== 'test' && body.expectedMode !== 'live') {
      return res.status(400).json({ error: 'expectedMode must be "test" or "live".' })
    }

    const report = analyzeWebhook({
      rawPayload: body.rawPayload,
      signatureHeader: body.signatureHeader,
      expectedMode: body.expectedMode
    })
    return res.json({ report })
  }
)

discovery(app, mppx, {
  info: {
    title: 'Stripe Webhook Debugger',
    version: '0.1.0'
  },
  serviceInfo: {
    categories: ['developer-tools', 'security'],
    docs: { apiReference: '/openapi.json', llms: '/llms.txt' }
  },
  routes: [{
    handler: paidDebug,
    method: 'post',
    path: '/api/debug',
    summary: 'Analyze a Stripe webhook event',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['rawPayload'],
            properties: {
              rawPayload: { type: 'string', description: 'Exact raw Stripe event JSON body.' },
              signatureHeader: { type: 'string', description: 'Optional Stripe-Signature header; format and timestamp only are checked.' },
              expectedMode: { type: 'string', enum: ['test', 'live'] }
            }
          }
        }
      }
    }
  }]
})

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error)

  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body exceeds the allowed size.' })
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' })
  }

  console.error('Unhandled request error:', error)
  return res.status(500).json({ error: 'Internal server error.' })
})

app.listen(port, () => {
  console.log(`Stripe Webhook Debugger listening on port ${port} (Tempo testnet payments only).`)
})
