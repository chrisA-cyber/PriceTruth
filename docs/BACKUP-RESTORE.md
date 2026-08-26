# Backup, restore, and disaster recovery

Target objectives for customer state are **RPO 15 minutes** and **RTO 60
minutes**. A platform snapshot alone is not a backup: keep encrypted,
versioned copies in a different failure domain and test restores.

## Backup

Run the application-provided SQLite snapshot command against the mounted data
volume:

```text
npm run db:backup -- --source /var/lib/pricetruth/pricetruth.db \
  --output /secure-backups/pricetruth-<UTC timestamp>.db
```

The command uses SQLite `VACUUM INTO` for a consistent snapshot while reads and
writes may continue, runs `PRAGMA quick_check`, streams SHA-256 calculation in
constant memory, and emits adjacent checksum/JSON metadata files. It refuses to
overwrite an existing backup.

Production scheduling requirements:

- verified incremental/platform snapshot at least every 15 minutes;
- daily application-level SQLite snapshot;
- 35 days of daily retention and 12 month-end copies;
- encryption in transit and at rest with a separately controlled key;
- delete permission restricted separately from backup-write permission;
- alert when the latest verified backup is older than 30 minutes;
- monthly restore drill into an isolated environment.

The scheduler and object-storage credentials live in the hosting platform, not
this repository. A release is blocked until its job history and restore evidence
are attached to the release ticket.

## Restore drill or recovery

1. Declare an incident and stop the application and worker.
2. Resolve the exact backup and target paths; verify the external object hash
   against the adjacent protected `.sha256` sidecar stored with the backup.
3. Copy the backup to an isolated host and run SQLite `PRAGMA integrity_check`.
4. Confirm no live target `-wal` or `-shm` sidecar exists.
5. Restore explicitly:

```text
npm run db:restore -- --source /restore/pricetruth.db \
  --target /var/lib/pricetruth/pricetruth.db --confirm-restore
```

The command integrity-checks the source, stages and checks a copy in the target
directory, retains the prior target as a timestamped rollback file, atomically
renames the verified stage, and checks the result again. If that final check
fails, the promoted candidate is quarantined as `*.failed-restore-*` and the
previous target is restored; an incomplete rollback is reported with both
recovery paths and never presented as success.

6. Start one application instance with billing traffic disabled if the
   incident involves entitlements.
7. Verify `/api/ready`, account login, watchlist, alert, entitlement, key, and
   history samples; then run the post-deploy check.
8. Re-enable webhooks/workers before customer traffic. Stripe and Resend event
   deduplication makes legitimate retries safe.
9. Record achieved RPO/RTO, selected snapshot, hashes, row-count checks, and
   every operator action in the incident timeline.

Never restore a database from an untrusted source, into a running process, or
over the only remaining copy.
