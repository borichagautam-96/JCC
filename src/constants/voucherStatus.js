// How a voucher's stored status maps to the three buckets a requestor cares about.
//
// There is no status literally called "pending". A voucher awaiting sign-off is
// `pending_approval_1` or `pending_approval_2`, and it can also be sitting with the
// requestor as `info_requested` or `recalled` — all of which are "not finished yet"
// from their point of view. My Voucher History counted `status === 'pending'`, which
// matches nothing, so that tile read 0 no matter how many claims were in flight.
//
// Kept here rather than inline so the next screen that needs these buckets cannot
// invent a fourth definition. `pending` DOES exist elsewhere in the schema — as an
// approver_status and a supplier_ack_status — which is most likely how the wrong
// literal ended up being compared against a voucher.

export const PENDING_STATUSES = [
  'pending_approval_1',   // with the manager
  'pending_approval_2',   // with the final approver
  'awaiting_approval',    // legacy rows written before the two-level split
  'info_requested',       // approver asked a question; back with the requestor
  'recalled',             // pulled back by the requestor, not yet resubmitted
];

// Everything after a full approval is still "approved" to the person who raised it —
// payment and vendor steps are downstream bookkeeping, not a different verdict.
export const APPROVED_STATUSES = ['approved', 'pending_payment', 'voucher_created'];

export const REJECTED_STATUSES = ['rejected'];

const inBucket = (bucket) => (status) => bucket.includes(String(status ?? '').trim().toLowerCase());

export const isPending = inBucket(PENDING_STATUSES);
export const isApproved = inBucket(APPROVED_STATUSES);
export const isRejected = inBucket(REJECTED_STATUSES);
