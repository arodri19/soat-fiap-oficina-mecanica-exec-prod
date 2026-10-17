const { DynamoExecutionRepository, ConcurrencyError } = require('../../src/infrastructure/persistence/DynamoExecutionRepository');
const { Execution } = require('../../src/domain/Execution');
const { SERVICES } = require('../support/inMemory');

const conditional = () => Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
const repoWith = (send) => new DynamoExecutionRepository({ tableName: 'exec', documentClient: { send: jest.fn(send) } });
const execution = () => Execution.create({ orderId: 42, sagaId: 's', services: SERVICES, now: new Date('2026-01-01T00:00:00Z') });

describe('DynamoExecutionRepository', () => {
  it('create grava chave da OS, índice de status e condição de unicidade', async () => {
    const repo = repoWith(async () => ({}));
    await expect(repo.create(execution())).resolves.toBe(true);
    const { input } = repo.client.send.mock.calls[0][0];
    expect(input).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: { pk: 'EXECUTION#42', gsi1pk: 'STATUS#QUEUED', gsi1sk: '2026-01-01T00:00:00.000Z' }
    });
    expect(input.Item).not.toHaveProperty('gsi2pk');
  });

  it('create: já existe → false; outro erro propaga', async () => {
    await expect(repoWith(async () => { throw conditional(); }).create(execution())).resolves.toBe(false);
    await expect(repoWith(async () => { throw new Error('x'); }).create(execution())).rejects.toThrow('x');
  });

  it('save com outbox pendente entra no índice esparso gsi2 e usa lock otimista', async () => {
    const repo = repoWith(async () => ({}));
    const e = execution();
    e.enqueueEvent({ messageId: 'm' });
    await repo.save(e);
    expect(e.version).toBe(1);
    const { input } = repo.client.send.mock.calls[0][0];
    expect(input).toMatchObject({ ConditionExpression: '#v = :expected', ExpressionAttributeValues: { ':expected': 0 } });
    expect(input.Item).toMatchObject({ gsi2pk: 'OUTBOX', version: 1 });
  });

  it('save: conflito de versão → ConcurrencyError; outro erro propaga', async () => {
    await expect(repoWith(async () => { throw conditional(); }).save(execution())).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(repoWith(async () => { throw new Error('y'); }).save(execution())).rejects.toThrow('y');
  });

  it('get reconstrói a entidade sem chaves técnicas', async () => {
    const stored = { pk: 'EXECUTION#42', gsi1pk: 'STATUS#QUEUED', gsi1sk: 'x', gsi2pk: 'OUTBOX', gsi2sk: 'y', ...execution() };
    const found = await repoWith(async () => ({ Item: stored })).get(42);
    expect(found).toBeInstanceOf(Execution);
    expect(found).not.toHaveProperty('gsi1pk');
    await expect(repoWith(async () => ({})).get(1)).resolves.toBeNull();
  });

  it('listByStatus, countByStatuses e listWithPendingOutbox consultam os índices', async () => {
    const repo = repoWith(async (cmd) => (cmd.input.Select === 'COUNT' ? { Count: 2 } : { Items: [{ pk: 'EXECUTION#42', ...execution() }] }));
    expect(await repo.listByStatus('QUEUED')).toHaveLength(1);
    expect(repo.client.send.mock.calls[0][0].input).toMatchObject({ IndexName: 'gsi1', ExpressionAttributeValues: { ':status': 'STATUS#QUEUED' }, ScanIndexForward: true });
    await expect(repo.countByStatuses(['QUEUED', 'DIAGNOSING'])).resolves.toBe(4);
    expect(await repo.listWithPendingOutbox()).toHaveLength(1);
    expect(repo.client.send.mock.calls[3][0].input).toMatchObject({ IndexName: 'gsi2', ExpressionAttributeValues: { ':outbox': 'OUTBOX' } });

    const empty = repoWith(async () => ({}));
    await expect(empty.listByStatus('X')).resolves.toEqual([]);
    await expect(empty.countByStatuses(['X'])).resolves.toBe(0);
    await expect(empty.listWithPendingOutbox()).resolves.toEqual([]);
  });

  it('cria DocumentClient real quando não injetado', () => {
    expect(new DynamoExecutionRepository({ tableName: 't', region: 'us-east-1', endpoint: 'http://localhost:4566' }).client).toBeDefined();
    expect(new DynamoExecutionRepository({ tableName: 't', region: 'us-east-1' }).client).toBeDefined();
  });
});
