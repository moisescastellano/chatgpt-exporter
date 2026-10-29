# ChatGPT Exporter — Rate Limiting Notes

This document explains the rate-limit strategy used by this fork and the evidence behind it.

The ChatGPT endpoints used by this exporter are internal and undocumented. The exact rate-limit algorithm, capacity, refill rate, and scope are therefore **not an OpenAI API contract** and may change without notice.

## What this fork does

The exporter deliberately uses a conservative strategy:

- ChatGPT API requests are paced, with starts separated by approximately one second.
- The first ChatGPT HTTP `429 Too Many Requests` stops further ChatGPT API activity for that export run.
- The exporter does not enter an automatic retry loop after a `429`.
- Already written JSON, Markdown, HTML, attachments, and generated files remain on disk.
- The UI reports the run as **paused** and shows processed/remaining conversation counts when available.
- If the response includes a `Retry-After` header, that value is shown to the user.
- A later run against the same output directory resumes through Smart Resume.
- A `429` from an external signed file-download host is not treated as a global ChatGPT API rate limit.

This behavior is intentional: once the account appears to have exhausted its request allowance, continuing to issue requests would mainly generate additional `429` responses and provide little useful progress.

## Community-observed model

A useful empirical description was published in July 2026 in issue
[#368 — Rate Limits (token bucket + 1req/m refill)](https://github.com/pionxzh/chatgpt-exporter/issues/368)
of the separate `pionxzh/chatgpt-exporter` project.

The investigation suggests that the conversation-reading endpoints behave approximately like a **token bucket**:

1. A fresh/full bucket appears to permit a burst of roughly **200–250 requests**.
2. Each request consumes capacity from that bucket.
3. Once depleted, capacity appears to return at roughly **one request per minute**.

The original report explicitly notes that the 200–250 request estimate still needs re-verification.

These values should therefore be treated as a **working model**, not as guaranteed limits.

## Why this matters for large exports

An export does not necessarily map one conversation to exactly one HTTP request.

Depending on the selected data and account structure, the exporter can also make requests for:

- paginated active conversation inventories;
- paginated archived conversation inventories;
- Project inventories;
- Project conversation inventories;
- Project metadata and resources;
- individual conversation bodies;
- custom GPT data;
- attachment and generated-file metadata.

For that reason, the number of conversations alone is not enough to predict the exact request count.

The token-bucket model does, however, explain an important pattern: an export may run quickly at first and then suddenly hit `429`, after which short repeated retries are unlikely to help much if the effective refill really is close to one request per minute.

## Why this fork stops instead of waiting automatically

There are several reasons not to build a long automatic wait/retry loop around an undocumented internal limit:

- the observed refill behavior is not official or guaranteed;
- the actual limit may change or differ between accounts/endpoints;
- ChatGPT may omit `Retry-After`;
- an export could otherwise remain running for many hours;
- Smart Resume makes stopping cheap because completed work is preserved.

The fork therefore prefers a deterministic rule:

> Stop on the first ChatGPT `429`, preserve progress, and let the user resume later.

When ChatGPT supplies `Retry-After`, the UI exposes it as useful information, but the exporter still avoids automatically committing to a long retry cycle.

## Practical recommendation

For large exports:

1. Use the same output directory on every run.
2. Let Smart Resume skip conversations that are already current.
3. If a `429` pauses the export, keep the existing output intact.
4. Resume later rather than deleting the export or starting from scratch.
5. Treat any precise request-capacity or refill estimate as observational and subject to change.

## Sources

- Community investigation: [pionxzh/chatgpt-exporter issue #368](https://github.com/pionxzh/chatgpt-exporter/issues/368)
- This fork intentionally documents the observation separately from its guaranteed behavior so that an external, empirical rate-limit model is not confused with an official OpenAI limit.
