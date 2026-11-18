/** Per-seat redaction lives in the shared, tested src/net/redact.ts (the dev mock server uses it too). */
export { redactEvents, seatView, snapshotFor, seenBy } from '../../src/net/redact';
