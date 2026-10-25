// Contratos de mensagens da saga (cópia local — ver docs/mensageria.md no os-service).
const crypto = require('node:crypto');

const SERVICE_NAME = 'exec-prod-service';

// Comandos recebidos do orquestrador na fila <prefixo>-execution-commands
const Commands = Object.freeze({
  START_EXECUTION: 'StartExecution',
  CANCEL_EXECUTION: 'CancelExecution'
});

// Respostas/eventos publicados na fila de respostas da saga (<prefixo>-os-saga-replies)
const Replies = Object.freeze({
  EXECUTION_QUEUED: 'ExecutionQueued',
  EXECUTION_REJECTED: 'ExecutionRejected',
  EXECUTION_STATUS_CHANGED: 'ExecutionStatusChanged',
  EXECUTION_COMPLETED: 'ExecutionCompleted',
  EXECUTION_FAILED: 'ExecutionFailed',
  EXECUTION_CANCELLED: 'ExecutionCancelled'
});

function createReply({ type, sagaId, orderId, correlationId, payload = {}, traceHeaders }) {
  return {
    messageId: crypto.randomUUID(),
    type,
    sagaId,
    orderId,
    correlationId: correlationId || sagaId,
    source: SERVICE_NAME,
    occurredAt: new Date().toISOString(),
    traceHeaders: traceHeaders || {},
    payload
  };
}

function isValidEnvelope(message) {
  return Boolean(
    message
    && typeof message.messageId === 'string'
    && typeof message.type === 'string'
    && message.payload !== null
    && typeof message.payload === 'object'
  );
}

module.exports = { SERVICE_NAME, Commands, Replies, createReply, isValidEnvelope };
