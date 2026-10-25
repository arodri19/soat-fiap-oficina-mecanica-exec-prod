// Precisa ser o primeiro require — o agente instrumenta express, http e aws-sdk.
require('newrelic');

const app = require('./app');
const config = require('./config');
const container = require('./container');
const { logger } = require('./middlewares/requestLogger');

const server = app.listen(config.PORT, () => {
  logger.info({ maxActive: config.MAX_ACTIVE_EXECUTIONS }, `exec-prod-service iniciado na porta ${config.PORT}`);
});

let outboxTimer = null;
if (config.MESSAGING_ENABLED) {
  container.getCommandConsumer().start();
  outboxTimer = setInterval(() => {
    container.getExecutionService().republishPendingEvents()
      .then((count) => count && logger.info({ count }, 'Eventos pendentes do outbox republicados'))
      .catch((error) => logger.error({ err: error }, 'Erro ao republicar outbox'));
  }, config.OUTBOX_RETRY_INTERVAL_MS);
  logger.info({ queues: config.QUEUES }, 'Consumidor de comandos da saga iniciado');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Encerrando exec-prod-service');
  if (outboxTimer) clearInterval(outboxTimer);
  if (config.MESSAGING_ENABLED) await container.getMessageBus().stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
