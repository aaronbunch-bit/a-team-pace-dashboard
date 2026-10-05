# Starburst live attribution

The pacer reconstructs provisional totals from exported attributions and purchase records. A successful query is not proof of recent source data.

Each snapshot stores a feed-wide attribution export watermark separately from the last team record and the time the query completed. Current-month exports older than three hours, or without a valid watermark, are flagged as potentially incomplete. Closed months are not expected to receive new sales. The threshold is a recency warning, not proof that an upstream job failed.

Refreshing this app cannot recreate records absent from the export source. The upstream export must be repaired/backfilled separately. No alternate attribution source is silently substituted.

## Private deployment configuration

OAuth credentials stay encrypted in private site storage. Existing verified ledger corrections and exclusions live in the private `private-starburst-ledger-rules` store at `reviewed-v1`, with schema version 1, `reviewedLedgers`, `excludedLedgerIds`, and `reviewedAt`. These must be provisioned from the existing private production configuration before deploying. Missing or invalid rules fail the refresh and preserve the prior snapshot. Never populate them from the synthetic fixtures in this repository.

The production Starburst integration was previously deployed outside GitHub. This change restores the running integration, including existing review/transfer support needed to preserve production behavior. Test fixtures use synthetic identities and IDs.
