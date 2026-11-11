import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeWebhook } from '../src/analyze.js'

const validEvent = {
  id: 'evt_12345',
  object: 'event',
  type: 'payment_intent.succeeded',
  created: 1_700_000_000,
  livemode: false,
  data: { object: { id: 'pi_12345', object: 'payment_intent' } }
}

test('validates a snapshot event and does not claim cryptographic signature verification', () => {
  const report = analyzeWebhook({
    rawPayload: JSON.stringify(validEvent),
    signatureHeader: `t=1700000000,v1=${'a'.repeat(64)}`,
    expectedMode: 'test',
    nowSeconds: 1_700_000_100
  })

  assert.equal(report.status, 'warning')
  assert.ok(report.checks.some(({ id, status }) => id === 'event_data' && status === 'pass'))
  assert.ok(report.checks.some(({ id, status }) => id === 'signature_verification' && status === 'warning'))
  assert.ok(report.recommendations.some((item) => item.includes('cryptographically')))
})

test('validates a thin event notification and recommends retrieving related state when needed', () => {
  const thinEvent = {
    id: 'evt_test_65UIRNU7G1XbhCfOim416TgmEI4ASQ3jHxXt8RFwXoeVwO',
    object: 'v2.core.event',
    type: 'v2.core.account.updated',
    created: '2026-03-09T13:00:28.435Z',
    livemode: false,
    related_object: {
      id: 'acct_1T93Q4Pmpb34Vto6',
      type: 'v2.core.account',
      url: '/v2/core/accounts/acct_1T93Q4Pmpb34Vto6'
    }
  }
  const report = analyzeWebhook({
    rawPayload: JSON.stringify(thinEvent),
    expectedMode: 'test',
    nowSeconds: 1_700_000_100
  })

  assert.equal(report.status, 'warning')
  assert.ok(report.checks.some(({ id, status }) => id === 'event_shape' && status === 'pass'))
  assert.ok(report.checks.some(({ id, status }) => id === 'related_object' && status === 'pass'))
  assert.ok(report.recommendations.some((item) => item.includes('Thin event notifications')))
})

test('reports malformed JSON as a diagnostic failure', () => {
  const report = analyzeWebhook({ rawPayload: '{"id":', nowSeconds: 1_700_000_100 })

  assert.equal(report.status, 'fail')
  assert.ok(report.checks.some(({ id, status }) => id === 'json_parse' && status === 'fail'))
})

test('detects a test/live mode mismatch', () => {
  const report = analyzeWebhook({
    rawPayload: JSON.stringify({ ...validEvent, livemode: true }),
    expectedMode: 'test',
    nowSeconds: 1_700_000_100
  })

  assert.equal(report.status, 'fail')
  assert.ok(report.checks.some(({ id, status }) => id === 'configured_mode' && status === 'fail'))
  assert.ok(report.recommendations.some((item) => item.includes('correct test or live')))
})

test('detects stale and malformed Stripe signature headers', () => {
  const stale = analyzeWebhook({
    rawPayload: JSON.stringify(validEvent),
    signatureHeader: `t=1699990000,v1=${'a'.repeat(64)}`,
    nowSeconds: 1_700_000_100
  })
  const malformed = analyzeWebhook({
    rawPayload: JSON.stringify(validEvent),
    signatureHeader: 't=1700000000,v1=not-a-signature',
    nowSeconds: 1_700_000_100
  })

  assert.ok(stale.checks.some(({ id, status }) => id === 'signature_timestamp' && status === 'fail'))
  assert.ok(malformed.checks.some(({ id, status }) => id === 'signature_header' && status === 'fail'))
})
