# Stripe Webhook Debugger

A pay-per-use API for inspecting Stripe webhook snapshot and thin event notifications. It validates the event envelope, checks the signature header's shape and timestamp, compares test/live mode, and returns security and integration recommendations.

The API intentionally does **not** accept webhook signing secrets or Stripe API keys. It does not cryptographically verify signatures; use Stripe's SDK in your own webhook handler with the endpoint secret and unmodified raw request body. Submitted event payloads are analyzed in memory and are not intentionally persisted.

## Run locally

Requires Node.js 18 or newer.

1. Copy `.env.example` to `.env`.
2. Set `MPP_SECRET_KEY` to a random server-only secret and `MPP_RECIPIENT` to your Tempo testnet receiving address. Never use a private key in `MPP_RECIPIENT`.
3. Install dependencies and start the service:

   ```sh
   npm install
   npm start
   ```

The service listens on port `4101` by default. Payment is locked to Tempo testnet pathUSD and costs `$0.01` per diagnostic request.

## API

- `POST /api/debug` — paid diagnostic. Provide `rawPayload` as a string containing the exact Stripe event body, with optional `signatureHeader` and `expectedMode` (`test` or `live`). Do not include secrets.
- `GET /openapi.json` — MPP discovery document with payment offers.
- `GET /llms.txt` — concise agent-facing service and pricing details.
- `GET /healthz` — process health check.

Malformed event JSON is returned as a diagnostic report; malformed request envelopes receive an HTTP 4xx response.

## Checks

```sh
npm test
npm run validate:mpp
```

Run the MPP validator while the server is listening. It reads the payment network from the server's challenge and requires a funded Tempo testnet client for the full paid-flow check.

## Vercel deployment

Vercel can detect `src/server.js` as an Express entry point and run it as a Vercel Function. The Stripe Projects catalog's Vercel project service deploys from a Git repository, so this folder must be pushed to a Git provider before it can be connected.

Configure `MPP_SECRET_KEY` and `MPP_RECIPIENT` as server-side Vercel environment variables. Keep the signing secret out of source control; the local `.env` and Stripe Projects state are ignored by Git.
