const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { Execution } = require('../../domain/Execution');

class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrencyError';
  }
}

const isConditionalFailure = (error) => error?.name === 'ConditionalCheckFailedException';

/**
 * Persistência da execução no DynamoDB (NoSQL, banco próprio do exec-prod):
 *
 *   pk     = EXECUTION#<orderId>                 (1 item por OS)
 *   gsi1pk = STATUS#<status>, gsi1sk = queuedAt   → fila por status, FIFO
 *   gsi2pk = OUTBOX (só quando há evento pendente) → índice esparso do outbox
 *
 * A linha do tempo (diagnóstico, reparo, notas do mecânico) é um documento
 * aninhado no próprio item — formato flexível, sem joins (motivo da escolha NoSQL).
 */
class DynamoExecutionRepository {
  constructor({ tableName, region, endpoint, documentClient }) {
    this.tableName = tableName;
    this.client = documentClient || DynamoDBDocumentClient.from(
      new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) }),
      { marshallOptions: { removeUndefinedValues: true } }
    );
  }

  #toItem(execution) {
    const item = {
      pk: `EXECUTION#${execution.orderId}`,
      gsi1pk: `STATUS#${execution.status}`,
      gsi1sk: execution.queuedAt,
      ...execution
    };
    if (execution.outbox.length) {
      item.gsi2pk = 'OUTBOX';
      item.gsi2sk = execution.updatedAt;
    }
    return item;
  }

  static #fromItem(item) {
    const { pk, gsi1pk, gsi1sk, gsi2pk, gsi2sk, ...rest } = item;
    return new Execution(rest);
  }

  async create(execution) {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: this.#toItem(execution),
        ConditionExpression: 'attribute_not_exists(pk)'
      }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async get(orderId) {
    const { Item } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `EXECUTION#${orderId}` },
      ConsistentRead: true
    }));
    return Item ? DynamoExecutionRepository.#fromItem(Item) : null;
  }

  // Lock otimista: só grava se ninguém alterou o item desde a leitura.
  async save(execution) {
    const expectedVersion = execution.version;
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: this.#toItem({ ...execution, version: expectedVersion + 1 }),
        ConditionExpression: '#v = :expected',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':expected': expectedVersion }
      }));
      execution.version = expectedVersion + 1;
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ConcurrencyError(`Execução da OS ${execution.orderId} alterada concorrentemente.`);
      }
      throw error;
    }
  }

  async listByStatus(status, limit = 100) {
    const { Items = [] } = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :status',
      ExpressionAttributeValues: { ':status': `STATUS#${status}` },
      ScanIndexForward: true,
      Limit: limit
    }));
    return Items.map((item) => DynamoExecutionRepository.#fromItem(item));
  }

  async countByStatuses(statuses) {
    const counts = await Promise.all(statuses.map(async (status) => {
      const { Count = 0 } = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :status',
        ExpressionAttributeValues: { ':status': `STATUS#${status}` },
        Select: 'COUNT'
      }));
      return Count;
    }));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  async listWithPendingOutbox(limit = 25) {
    const { Items = [] } = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :outbox',
      ExpressionAttributeValues: { ':outbox': 'OUTBOX' },
      Limit: limit
    }));
    return Items.map((item) => DynamoExecutionRepository.#fromItem(item));
  }
}

module.exports = { DynamoExecutionRepository, ConcurrencyError };
