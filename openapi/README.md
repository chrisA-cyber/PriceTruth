# PriceTruth OpenAPI contract

`openapi.json` is the OpenAPI 3.1 contract for public, account, webhook,
operator, and B2B v1 routes. Regenerate it with:

```text
node scripts/generate-openapi.mjs
npm run api:check
```

The contract uses `x-idempotency.strategy` on every operation to state actual
retry behavior. A generic inbound `Idempotency-Key` is deliberately not
advertised: only provider webhooks and specific durable jobs currently have
persistent deduplication keys.

SDK generation is intentionally downstream from validation. For example:

```text
docker run --rm -v "$PWD:/local" openapitools/openapi-generator-cli generate \
  -i /local/openapi/openapi.json -g typescript-fetch \
  -c /local/openapi/typescript-fetch.json -o /local/dist/sdk/typescript
```

Generated clients are release artifacts, not hand-edited source. Review any
generator image and pin it by digest in the release pipeline before publishing.
