const { isValidEnvelope } = require('../../application/contracts');
const { runConsumerTransaction } = require('../monitoring/tracing');

// Liga a fila de comandos do exec-prod (SQS) ao ExecutionService. Erro no handler →
// mensagem não é apagada → SQS reentrega (e manda para a DLQ após N tentativas).
class CommandConsumer {
  constructor({ messageBus, executionService, queueName, logger }) {
    this.messageBus = messageBus;
    this.executionService = executionService;
    this.queueName = queueName;
    this.logger = logger;
  }

  async handle(envelope) {
    if (!isValidEnvelope(envelope)) {
      this.logger.error({ envelope }, 'Envelope inválido na fila de comandos — descartado');
      return { outcome: 'INVALID' };
    }
    return runConsumerTransaction(`execution-command/${envelope.type}`, envelope.traceHeaders, async () => {
      const result = await this.executionService.handleCommand(envelope);
      this.logger.info(
        { type: envelope.type, sagaId: envelope.sagaId, orderId: envelope.orderId, correlationId: envelope.correlationId, ...result },
        'Comando processado'
      );
      return result;
    });
  }

  start() {
    return this.messageBus.subscribe(this.queueName, (envelope) => this.handle(envelope));
  }
}

module.exports = CommandConsumer;
