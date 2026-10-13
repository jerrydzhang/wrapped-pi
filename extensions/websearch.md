# websearch extension

Native Pi extension adding two tools — `web_search` and `web_fetch` — authored
independently for the pinned Pi extension API (0.87.0). Single file, zero npm
dependencies.

- **`web_search {query, numResults?}`** — returns source titles, URLs and
  excerpts (≤240 chars) with provider attribution. Keyless Exa MCP primary;
  ZAI fallback when `ZAI_API_KEY` is set. No answer generation, no
  classification. Recency/site operators may be typed inside the query;
  they are forwarded verbatim, without a filtering guarantee.
- **`web_fetch {url, maxChars?}`** — returns page content with the source URL
  stated. Inline bound defaults to 20,000 chars (max 200,000); larger content
  is written to a unique per-invocation temp file whose path is returned for
  ordinary reads. Content at the provider's extraction cap (200,000 chars) is
  labeled as possibly incomplete, never as the complete page.

Both tools enforce the pinned Pi bounded-tool contract (public SDK constants
`DEFAULT_MAX_BYTES` 50KB and `DEFAULT_MAX_LINES` 2000) independently of caller
arguments: anything larger is cut at a valid code point boundary, spilled to
a unique temp file, and returned as a bounded preview plus a full-output
pointer. Provider attempts share one 30s deadline (handshake through
response); failures are reported honestly (providers tried and causes,
credential bytes scrubbed before truncation); caller cancellation never
triggers fallback. ZAI result links are domain-level as the provider returns
them, and are disclosed as such.

## Loading

Run `nix run .` to launch wrapped-pi with this extension. It preserves normal
Pi configuration and extension discovery; no global installation is needed.

For source development, load it directly with plain Pi:
`pi -e extensions/websearch.ts` (path relative to this repo).

Credentials are read from the environment only: `ZAI_API_KEY` (optional
fallback; its absence is reported, never an error). Keys are never logged or
echoed; provider error text is scrubbed of credential bytes before surfacing.

## Tests

```
node --test extensions/websearch.test.ts
```

Contract coverage over fake provider transports: section/structured parsing,
raw passthrough, Exa→ZAI fallback, missing key, total-failure attribution,
credential redaction, cancellation without fallback, numeric bounds, temp-file
overflow, and URL-scheme rejection.
