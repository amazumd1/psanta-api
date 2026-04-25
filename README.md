# psanta-api
This folder is only for backend.

## Retail path contract freeze

Canonical retail backend paths are frozen to:

- `tenants/{tenantId}/gmailConnections/main`
- `tenants/{tenantId}/gmailReceiptSettings/main`
- `tenants/{tenantId}/receiptAllowlist/{docId}`
- `tenants/{tenantId}/retailReceipts/{tenantId__rawId}`
- `tenants/{tenantId}/retailReceipts_failed/{tenantId__rawId}`
- `tenants/{tenantId}/retailReceiptRuns/{tenantId__runId}`

Rules:
- `main` is the only allowed singleton doc id for Gmail connection/settings docs.
- Receipt and failure docs must use `{tenantId}__{rawId}`.
- Run docs must use `{tenantId}__{runId}`.
- New retail writes must use shared path helpers from `services/api/lib/retailPaths.js`.

## Retail legacy cutover

Canonical cutover endpoints:
- `GET /api/receipts/google/cutover-status`
- `POST /api/receipts/google/cutover-legacy`
- `POST /api/receipts/google/migrate-legacy` (legacy alias)

The one-time cutover writes its completion record to `tenants/{tenantId}/gmailReceiptSettings/main` under `legacyCutover`.

## Retail Gmail route contract

Canonical public retail Gmail route:
- `/api/receipts/google`

Internal legacy route namespace:
- `/api/internal/receipts/google-legacy`

Route implementation files:
- Canonical public route: `services/api/routes/retailReceipts.gmail.routes.js`
- Internal legacy route: `services/api/routes/internal/legacyGmailReceipts.routes.js`

Deprecated import/mounts:
- `services/api/routes/retailreceipt/receipts.gmail.routes.js` is now only a compatibility stub
- `/api/receipts/google-personal` is removed
- `/api/internal/receipts/google-tenant` is replaced by `/api/internal/receipts/google-legacy`

Canonical retail Gmail env names:
- `RETAIL_GMAIL_CLIENT_ID`
- `RETAIL_GMAIL_CLIENT_SECRET`
- `RETAIL_GMAIL_REDIRECT_URI`
- `RETAIL_GMAIL_WEBAPP_URL`
- `RETAIL_GMAIL_WEBAPP_SECRET`
- `RETAIL_GMAIL_SUCCESS_URL`

Legacy env names remain temporary fallbacks only and should be removed after rollout.