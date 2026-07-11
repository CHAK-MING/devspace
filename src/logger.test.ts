import assert from "node:assert/strict";
import { httpRequestLogLevel, shouldLog, type LoggingConfig } from "./logger.js";

assert.equal(httpRequestLogLevel("/mcp", 200), "debug");
assert.equal(httpRequestLogLevel("/mcp", 202), "debug");
assert.equal(httpRequestLogLevel("/mcp", 400), "warn");
assert.equal(httpRequestLogLevel("/mcp", 503), "error");
assert.equal(httpRequestLogLevel("/healthz", 200), "info");

const config: LoggingConfig = {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
};
assert.equal(shouldLog(config, "info"), true);
assert.equal(shouldLog(config, "debug"), false);

console.log("All logger tests passed.");
