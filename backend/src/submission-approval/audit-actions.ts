export const AUDIT_ACTIONS = {
  review: 'review',
  update: 'update',
  finalize: 'finalize',
  fraudEnqueued: 'fraud_enqueued',
  fraudEnqueueFailed: 'fraud_enqueue_failed',
  fraudReused: 'fraud_reused',
  fraudResolved: 'fraud_resolved',
  noteUpdate: 'note_update',
  permReject: 'perm_reject',
  permRejectCleared: 'perm_reject_cleared',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const SYSTEM_ACTOR_ID = 0;
