import assert from "node:assert/strict";
import test from "node:test";
import type { ClsObservabilityConfig } from "../src/config.js";
import { buildResourceAttributes } from "../src/telemetry/provider.js";

test("production resource includes CLS required service and host fields", () => {
  const attrs = buildResourceAttributes({
    serviceName: "openclaw-gateway",
    serviceInstanceId: "instance-1",
    hostName: "host-1",
    environment: "production",
  } as ClsObservabilityConfig);
  assert.equal(attrs["service.name"], "openclaw-gateway");
  assert.equal(attrs["host.name"], "host-1");
  assert.equal(attrs["deployment.environment.name"], "production");
  assert.equal(attrs["service.instance.id"], "instance-1");
});
