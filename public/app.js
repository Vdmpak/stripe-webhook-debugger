const samplePayload = {
  id: 'evt_1PqJ8x2eZvKYlo2C0WT8s9j3',
  object: 'event',
  type: 'payment_intent.succeeded',
  created: 1712098420,
  livemode: false,
  data: {
    object: {
      id: 'pi_3PqJ7e2eZvKYlo2C1Zb2Wk7q',
      object: 'payment_intent',
      amount: 2400,
      currency: 'usd',
      status: 'succeeded'
    }
  }
}

const payloadInput = document.querySelector('#payload')
const analyzeButton = document.querySelector('#analyze-button')
const reportOutput = document.querySelector('#demo-report')
const payloadStatus = document.querySelector('#payload-status')
const requestCode = document.querySelector('#request-code')
const copyButton = document.querySelector('#copy-button')

payloadInput.value = JSON.stringify(samplePayload, null, 2)

const displayedRequest = {
  rawPayload: JSON.stringify(samplePayload),
  expectedMode: 'test'
}
requestCode.innerHTML = `{
  <span class="code-key">"rawPayload"</span>: <span class="code-string">${escapeHtml(JSON.stringify(displayedRequest.rawPayload))}</span>,
  <span class="code-key">"expectedMode"</span>: <span class="code-string">"test"</span>
}`

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character])
}

function addCheck(container, label, passed) {
  const row = document.createElement('div')
  row.className = `report-check${passed ? '' : ' warn'}`
  const icon = document.createElement('span')
  icon.textContent = passed ? '✓' : '!'
  const text = document.createElement('span')
  text.textContent = label
  const result = document.createElement('b')
  result.textContent = passed ? 'PASS' : 'REVIEW'
  row.append(icon, text, result)
  container.append(row)
}

function renderReport(payloadText) {
  let event
  try {
    event = JSON.parse(payloadText)
  } catch {
    reportOutput.replaceChildren()
    const report = document.createElement('div')
    report.className = 'report-card'
    const summary = document.createElement('div')
    summary.className = 'report-summary'
    summary.textContent = 'Could not parse JSON'
    const message = document.createElement('p')
    message.className = 'report-message'
    message.textContent = 'Check commas, quotes, and brackets, then try the preview again.'
    report.append(summary, message)
    reportOutput.append(report)
    payloadStatus.textContent = 'Invalid JSON'
    return
  }

  const checks = [
    ['Stripe event envelope', event && typeof event === 'object' && !Array.isArray(event) && ['event', 'v2.core.event'].includes(event.object)],
    ['Event identifier', typeof event?.id === 'string' && /^evt_[A-Za-z0-9_]+$/.test(event.id)],
    ['Event type', typeof event?.type === 'string' && /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(event.type)],
    ['Test/live mode declared', typeof event?.livemode === 'boolean'],
    ['Resource reference', event?.object === 'v2.core.event'
      ? Boolean(event.related_object?.id && event.related_object?.type && event.related_object?.url?.startsWith('/'))
      : Boolean(event?.data?.object && typeof event.data.object === 'object')]
  ]
  const failed = checks.filter(([, passed]) => !passed).length
  const thinEvent = event?.object === 'v2.core.event'
  const report = document.createElement('div')
  report.className = 'report-card'
  const summary = document.createElement('div')
  summary.className = 'report-summary'
  const pill = document.createElement('span')
  pill.className = 'status-pill'
  pill.textContent = failed ? `${failed} CHECK${failed === 1 ? '' : 'S'} TO REVIEW` : 'STRUCTURE LOOKS GOOD'
  summary.append(pill, document.createTextNode(typeof event?.type === 'string' ? event.type : 'Event preview'))
  report.append(summary)

  for (const [label, passed] of checks) addCheck(report, label, passed)
  addCheck(report, 'Cryptographic signature', false)

  const message = document.createElement('p')
  message.className = 'report-message'
  message.textContent = failed
    ? 'Fix the highlighted event fields and check your Stripe event format.'
    : 'This is a local structure preview only. Verify signatures with Stripe’s SDK, the original raw body, and your endpoint secret.'
  report.append(message)

  if (thinEvent) {
    const hint = document.createElement('p')
    hint.className = 'report-message'
    hint.textContent = 'Thin events contain a resource reference; retrieve its state from Stripe when your handler needs it.'
    report.append(hint)
  }

  reportOutput.replaceChildren(report)
  payloadStatus.textContent = failed ? 'Preview complete · review highlighted checks' : 'Preview complete · structure looks good'
}

analyzeButton.addEventListener('click', () => renderReport(payloadInput.value))
payloadInput.addEventListener('input', () => {
  payloadStatus.textContent = 'Payload edited · run preview to refresh'
})

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(displayedRequest, null, 2))
    copyButton.textContent = 'COPIED'
    setTimeout(() => { copyButton.textContent = 'COPY' }, 1500)
  } catch {
    copyButton.textContent = 'SELECT TEXT'
  }
})

renderReport(payloadInput.value)
