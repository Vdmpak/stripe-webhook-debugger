const MAX_PAYLOAD_BYTES = 240 * 1024
const SIGNATURE_TOLERANCE_SECONDS = 300

function check(id, status, message) {
  return { id, status, message }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function signatureChecks(header, nowSeconds) {
  if (!header) {
    return [
      check('signature_header', 'warning', 'No Stripe-Signature header was provided.'),
      check('signature_verification', 'warning', 'The webhook signature cannot be verified from an event payload alone.')
    ]
  }

  const fields = header.split(',').map((field) => field.trim().split('=', 2))
  const timestamps = fields.filter(([key]) => key === 't').map(([, value]) => value)
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value)
  const timestamp = timestamps.length === 1 ? Number(timestamps[0]) : NaN

  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || signatures.length === 0 ||
      signatures.some((value) => !/^[a-f\d]{64}$/i.test(value))) {
    return [
      check('signature_header', 'fail', 'The Stripe-Signature header is malformed; expected one timestamp and at least one 64-character v1 signature.'),
      check('signature_verification', 'warning', 'The signature was not cryptographically verified.')
    ]
  }

  const ageSeconds = Math.abs(nowSeconds - timestamp)
  const timestampCheck = ageSeconds > SIGNATURE_TOLERANCE_SECONDS
    ? check('signature_timestamp', 'fail', `The signature timestamp is outside the default ${SIGNATURE_TOLERANCE_SECONDS}-second tolerance.`)
    : check('signature_timestamp', 'pass', 'The signature timestamp is within the default five-minute tolerance.')

  return [
    check('signature_header', 'pass', 'The Stripe-Signature header has a timestamp and v1 signature in the expected format.'),
    timestampCheck,
    check('signature_verification', 'warning', 'Header format and timestamp are checked only; cryptographic verification requires your endpoint secret and the original raw request body.')
  ]
}

function summarize(checks) {
  if (checks.some(({ status }) => status === 'fail')) return 'fail'
  if (checks.some(({ status }) => status === 'warning')) return 'warning'
  return 'pass'
}

export function analyzeWebhook({
  rawPayload,
  signatureHeader,
  expectedMode,
  nowSeconds = Math.floor(Date.now() / 1000)
}) {
  const checks = []
  let event

  if (Buffer.byteLength(rawPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
    checks.push(check('payload_size', 'fail', 'The raw payload exceeds the 240 KiB analysis limit.'))
    return { status: 'fail', checks, recommendations: ['Reduce the payload size before submitting it.'] }
  }

  try {
    event = JSON.parse(rawPayload)
  } catch {
    checks.push(check('json_parse', 'fail', 'The raw payload is not valid JSON.'))
    checks.push(...signatureChecks(signatureHeader, nowSeconds))
    return {
      status: summarize(checks),
      checks,
      recommendations: [
        'Send the exact raw JSON body received from Stripe; do not reserialize it before signature verification.',
        'Verify the signature in your own webhook handler with the Stripe SDK and endpoint secret.'
      ]
    }
  }

  const isSnapshot = isRecord(event) && event.object === 'event'
  const isThin = isRecord(event) && event.object === 'v2.core.event'

  if (!isRecord(event)) {
    checks.push(check('event_shape', 'fail', 'A Stripe event notification must be a JSON object.'))
  } else {
    checks.push(check('event_shape', isSnapshot || isThin ? 'pass' : 'fail',
      isSnapshot
        ? 'The payload identifies itself as a Stripe snapshot event.'
        : isThin
          ? 'The payload identifies itself as a Stripe thin event notification.'
          : 'Expected object to be "event" (snapshot) or "v2.core.event" (thin).'))

    checks.push(check('event_id', typeof event.id === 'string' && /^evt_[A-Za-z0-9_]+$/.test(event.id) ? 'pass' : 'fail',
      typeof event.id === 'string' && /^evt_[A-Za-z0-9_]+$/.test(event.id)
        ? 'The event has a Stripe event ID.'
        : 'Expected an event ID beginning with evt_.'))

    checks.push(check('event_type', typeof event.type === 'string' && /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(event.type) ? 'pass' : 'fail',
      typeof event.type === 'string' && /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(event.type)
        ? 'The event type is present and well formed.'
        : 'Expected a dotted Stripe event type such as payment_intent.succeeded.'))

    const validCreated = isThin
      ? typeof event.created === 'string' && Number.isFinite(Date.parse(event.created))
      : Number.isSafeInteger(event.created) && event.created > 0
    checks.push(check('created', validCreated ? 'pass' : 'fail',
      isThin
        ? validCreated
          ? 'The thin event has a valid ISO 8601 timestamp.'
          : 'Expected created to be a valid ISO 8601 timestamp for a thin event.'
        : validCreated
          ? 'The snapshot event has a positive Unix timestamp.'
          : 'Expected created to be a positive Unix timestamp in seconds.'))

    checks.push(check('livemode', typeof event.livemode === 'boolean' ? 'pass' : 'fail',
      typeof event.livemode === 'boolean'
        ? `The event declares ${event.livemode ? 'live' : 'test'} mode.`
        : 'Expected livemode to be a boolean.'))

    if (isSnapshot) {
      checks.push(check('event_data', isRecord(event.data) && isRecord(event.data.object) ? 'pass' : 'fail',
        isRecord(event.data) && isRecord(event.data.object)
          ? 'The snapshot event includes data.object.'
          : 'Expected data.object to contain the event resource.'))
    } else if (isThin) {
      const relatedObjectIsValid = isRecord(event.related_object) &&
        typeof event.related_object.id === 'string' &&
        typeof event.related_object.type === 'string' &&
        typeof event.related_object.url === 'string' &&
        event.related_object.url.startsWith('/')
      checks.push(check('related_object', relatedObjectIsValid ? 'pass' : 'fail',
        relatedObjectIsValid
          ? 'The thin event includes a related resource reference.'
          : 'Expected related_object to include an ID, type, and relative API URL.'))
    }

    if (expectedMode) {
      const expectedLiveMode = expectedMode === 'live'
      const modeMatches = typeof event.livemode === 'boolean' && event.livemode === expectedLiveMode
      checks.push(check('configured_mode', modeMatches ? 'pass' : 'fail',
        modeMatches
          ? `The event mode matches the configured ${expectedMode} environment.`
          : `The event livemode does not match the configured ${expectedMode} environment.`))
    }
  }

  checks.push(...signatureChecks(signatureHeader, nowSeconds))
  const recommendations = [
    'Verify Stripe-Signature cryptographically in your own webhook endpoint using the Stripe SDK, endpoint secret, and unmodified raw request body.',
    'Deduplicate deliveries using event.id and make event handling safe to retry.',
    'Acknowledge valid events quickly with a 2xx response, then move slow work to a background job.',
    'Keep test and live webhook endpoints, signing secrets, and API keys separate.'
  ]

  if (isThin) {
    recommendations.unshift('Thin event notifications contain a resource reference rather than a full snapshot; retrieve the event or related resource from Stripe when your handler needs its state.')
  }
  if (!signatureHeader) {
    recommendations.unshift('Require the Stripe-Signature header on your webhook endpoint.')
  }
  if (expectedMode && isRecord(event) && typeof event.livemode === 'boolean' && event.livemode !== (expectedMode === 'live')) {
    recommendations.unshift('Check that the event was sent to the correct test or live webhook destination.')
  }

  return { status: summarize(checks), checks, recommendations }
}

export const MAX_PAYLOAD_BYTES_LIMIT = MAX_PAYLOAD_BYTES
