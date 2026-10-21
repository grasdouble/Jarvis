import assert from "node:assert/strict";
import { test } from "node:test";
import * as persistence from "../dist/index.js";

test("persistence exposes the durable PostgreSQL queue store", () => {
  assert.equal(typeof persistence.PostgresQueueStore, "function");
});
