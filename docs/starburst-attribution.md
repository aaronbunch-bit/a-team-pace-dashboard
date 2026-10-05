# Starburst live attribution

The pacer reconstructs provisional totals from exported attributions and purchase records. A successful query is not proof of recent source data.

Each snapshot stores a feed-wide attribution export watermark separately from the last team record and the time the query completed. Current-month exports older than three hours, or without a valid watermark, are flagged as potentially incomplete. Closed months are not expected to receive new sales. The threshold is a recency warning, not proof that an upstream job failed.

The combined feed supplements missing membership purchases with purchase-to-lead and purchase-to-call links, participant roles, and qualifying call history. Allocations are deduplicated by purchase ID. Any exported purchase or exported client/day takes precedence, including unresolved and privately reviewed records. Reconstructed allocations disappear when the export arrives, rather than being added again.

The supplement accepts a first/last-rep allocation only when the 90- and 240-second qualifying-call selections agree. It retains co-reps outside the selected team when calculating the split. Refunds, closely spaced purchases, cross-product allocations, missing durations and disputed thresholds remain in the existing review queue. Reconstructed rows are provisional, never described as authoritative ledger entries. The live banner reports the added purchase count and pending review records.

Combined snapshots track purchase, call and purchase-match watermarks independently. The oldest component controls freshness; the export delay remains visible separately. A failed or partial query preserves the prior complete snapshot. Sources without a team identity link cannot establish team ownership and are not silently assigned to a rep.

Validation on October 5 used October 1–4 Central purchases. All 76 eligible overlapping purchases across the two pacers matched existing rep allocations and credited hours. This is bounded validation, not a guarantee that reconstructed activity includes every sale or later ledger correction. Tests cover export precedence, ambiguous export suppression, cross-team splits, duplicates, refund exclusions, threshold disagreement, review IDs and missing data. Production data and validation records remain outside this public repository.

## Private deployment configuration

OAuth credentials stay encrypted in private site storage. Existing verified ledger corrections and exclusions live in the private `private-starburst-ledger-rules` store at `reviewed-v1`, with schema version 1, `reviewedLedgers`, `excludedLedgerIds`, and `reviewedAt`. These must be provisioned from the existing private production configuration before deploying. Missing or invalid rules fail the refresh and preserve the prior snapshot. Never populate them from the synthetic fixtures in this repository.

The production Starburst integration was previously deployed outside GitHub. This change restores the running integration, including existing review/transfer support needed to preserve production behavior. Test fixtures use synthetic identities and IDs.
