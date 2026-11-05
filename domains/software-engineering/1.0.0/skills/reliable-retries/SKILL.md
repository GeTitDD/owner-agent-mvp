---
name: reliable-retries
description: Review retry, idempotency, and failure recovery designs in coding tasks
---

# Reliable retries

Use when the task involves retrying external actions, queue workers, webhooks or payments.

1. Identify which operations may have external side effects.
2. Define the idempotency boundary, deduplication key, and persistence strategy.
3. Verify transaction and crash-recovery scenarios with tests.
4. Identify stale workers, timeout, and duplicate delivery races.
5. Keep project-specific code and secrets out of shared knowledge artifacts.

When implementation-specific details are needed, consult the project source and `domain_recall`.
