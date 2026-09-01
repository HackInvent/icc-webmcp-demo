import { createParisIccServer } from "./app.mjs";
import {
  ConfigurationError,
  loadServerConfig,
  resolveConfigPath,
} from "./config.mjs";

let config;
try {
  const configPath = resolveConfigPath();
  config = loadServerConfig(configPath);
} catch (error) {
  const message = error instanceof ConfigurationError || error instanceof Error
    ? error.message
    : "Unknown configuration error.";
  console.error(`Paris ICC could not start: ${message}`);
  process.exitCode = 1;
}

if (config) {
  const { server, close, agentRuntimeStore } = createParisIccServer(config);
  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `Paris ICC listening on ${config.server.host}:${config.server.port} ` +
      `for ${config.application.publicOrigin} (${config.application.dataMode}; ` +
      `agent ${config.openai.enabled ? agentRuntimeStore.currentModel() : "disabled"}).`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; closing Paris ICC.`);
    try {
      await close();
    } catch (error) {
      console.error("Paris ICC shutdown failed.", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
