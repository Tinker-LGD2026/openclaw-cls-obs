import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsage, usageAttributes } from "../src/domain/usage.js";

test("cache buckets are included in CLS input and total", () => {
  assert.deepEqual(
    normalizeUsage({ input: 122, output: 70, cacheRead: 41_728, cacheWrite: 0, total: 41_920 }),
    {
      input: 41_850,
      output: 70,
      total: 41_920,
      cacheRead: 41_728,
      cacheCreation: 0,
      cacheMiss: 122,
      hostTotal: 41_920,
      totalMismatch: false,
    },
  );
});

test("cache creation is an input-token subset", () => {
  const normalized = normalizeUsage({
    input: 20,
    output: 5,
    cacheRead: 100,
    cacheWrite: 30,
    total: 155,
  });
  assert.equal(normalized.input, 150);
  assert.equal(normalized.total, 155);
  assert.equal(normalized.cacheMiss, 20);
});

test("invalid and negative usage values are ignored", () => {
  assert.deepEqual(normalizeUsage({ input: -1, output: Number.NaN }), {
    input: 0,
    output: 0,
    total: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheMiss: 0,
    totalMismatch: false,
  });
});

test("usage attributes include official cache fields and mismatch marker", () => {
  const attrs = usageAttributes(
    normalizeUsage({ input: 10, output: 5, cacheRead: 100, total: 999 }),
  );
  assert.equal(attrs["gen_ai.usage.input_tokens"], 110);
  assert.equal(attrs["gen_ai.usage.output_tokens"], 5);
  assert.equal(attrs["gen_ai.usage.total_tokens"], 115);
  assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 100);
  assert.equal(attrs["openclaw.usage.host_total_tokens"], 999);
  assert.equal(attrs["openclaw.usage.total_mismatch"], true);
});

// The spec's token dictionary (4.2.5) has no cache-miss field, so the derived
// uncached remainder must not occupy the protocol namespace.
test("cache miss is a vendor field because the spec defines no such token bucket", () => {
  const attrs = usageAttributes(normalizeUsage({ input: 10, output: 5, cacheRead: 100 }));
  assert.equal(attrs["gen_ai.usage.cache_miss.input_tokens"], undefined);
  assert.equal(attrs["openclaw.usage.cache_miss.input_tokens"], 10);
});
