const dotenv = require('dotenv');

dotenv.config();

const PREFIX = process.env.QUEUE_PREFIX || 'oficina-mecanica-dev';
const intEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isNaN(value) ? fallback : value;
};

module.exports = {
  PORT: process.env.PORT || 4200,
  JWT_SECRET: process.env.JWT_SECRET || 'change-me',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  SQS_ENDPOINT: process.env.SQS_ENDPOINT || '',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT || '',
  MESSAGING_ENABLED: process.env.MESSAGING_ENABLED !== 'false',
  TABLE_NAME: process.env.EXECUTIONS_TABLE || `${PREFIX}-executions`,
  QUEUES: {
    commands: process.env.EXECUTION_COMMANDS_QUEUE || `${PREFIX}-execution-commands`,
    osReplies: process.env.OS_REPLIES_QUEUE || `${PREFIX}-os-saga-replies`
  },
  // Capacidade da oficina: OS simultâneas na fila + em execução. Acima disso o
  // StartExecution é recusado e a saga compensa (estorno). 0 força a recusa (demo).
  MAX_ACTIVE_EXECUTIONS: intEnv('MAX_ACTIVE_EXECUTIONS', 10),
  OUTBOX_RETRY_INTERVAL_MS: intEnv('OUTBOX_RETRY_INTERVAL_MS', 10_000)
};
