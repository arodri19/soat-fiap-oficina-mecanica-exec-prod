const config = require('./config');
const { logger } = require('./middlewares/requestLogger');
const SqsMessageBus = require('./infrastructure/messaging/SqsMessageBus');
const CommandConsumer = require('./infrastructure/messaging/CommandConsumer');
const { DynamoExecutionRepository } = require('./infrastructure/persistence/DynamoExecutionRepository');
const monitoring = require('./infrastructure/monitoring/newrelicEvents');
const tracing = require('./infrastructure/monitoring/tracing');
const { ExecutionService } = require('./application/ExecutionService');

const instances = new Map();
const single = (key, factory) => {
  if (!instances.has(key)) instances.set(key, factory());
  return instances.get(key);
};

const container = {
  getMessageBus: () => single('messageBus', () => new SqsMessageBus({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT || undefined,
    logger
  })),
  getRepository: () => single('repository', () => new DynamoExecutionRepository({
    tableName: config.TABLE_NAME,
    region: config.AWS_REGION,
    endpoint: config.DYNAMODB_ENDPOINT || undefined
  })),
  getExecutionService: () => single('executionService', () => new ExecutionService({
    repository: container.getRepository(),
    messageBus: container.getMessageBus(),
    defaultReplyQueue: config.QUEUES.osReplies,
    maxActiveExecutions: config.MAX_ACTIVE_EXECUTIONS,
    monitoring,
    tracing,
    logger
  })),
  getCommandConsumer: () => single('commandConsumer', () => new CommandConsumer({
    messageBus: container.getMessageBus(),
    executionService: container.getExecutionService(),
    queueName: config.QUEUES.commands,
    logger
  }))
};

module.exports = container;
