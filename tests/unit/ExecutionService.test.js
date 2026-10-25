const { ExecutionService } = require('../../src/application/ExecutionService');
const { InvalidTransitionError, ValidationError } = require('../../src/domain/errors');
const { Execution } = require('../../src/domain/Execution');
const {
  InMemoryExecutionRepository, RecordingBus, silentLogger, fakeTracing, fakeMonitoring, command, startPayload
} = require('../support/inMemory');

function setup({ maxActiveExecutions = 10 } = {}) {
  const repository = new InMemoryExecutionRepository();
  const bus = new RecordingBus();
  let tick = 0;
  const service = new ExecutionService({
    repository, messageBus: bus, defaultReplyQueue: 'default-replies', maxActiveExecutions,
    monitoring: fakeMonitoring(), tracing: fakeTracing, logger: silentLogger,
    clock: () => new Date(Date.UTC(2026, 9, 17, 10, 0, tick++))
  });
  return { repository, bus, service };
}

const start = (ctx, orderId = 42, payload = startPayload()) => ctx.service.handleCommand(command('StartExecution', payload, { orderId }));

describe('StartExecution', () => {
  it('coloca a OS na fila e responde ExecutionQueued com a posição', async () => {
    const ctx = setup();
    await start(ctx, 41);
    await expect(start(ctx)).resolves.toEqual({ outcome: 'ExecutionQueued' });
    expect(ctx.bus.last()).toMatchObject({
      queue: 'os-replies', type: 'ExecutionQueued', sagaId: 'saga-1', orderId: 42, source: 'exec-prod-service',
      payload: { executionId: 'EXEC-42', status: 'QUEUED', queuePosition: 2, estimatedMinutes: 60 }
    });
  });

  it('reentrega responde o mesmo resultado sem duplicar', async () => {
    const ctx = setup();
    await start(ctx);
    await start(ctx);
    expect(ctx.repository.items.size).toBe(1);
    expect(ctx.bus.published.map((m) => m.type)).toEqual(['ExecutionQueued', 'ExecutionQueued']);
  });

  it('reentrega após cancelamento responde ExecutionRejected', async () => {
    const ctx = setup();
    await start(ctx);
    await ctx.service.handleCommand(command('CancelExecution', {}));
    await start(ctx);
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionRejected', payload: { reason: 'Execução já cancelada para esta OS' } });
  });

  it('reentrega de OS já em diagnóstico responde sem posição de fila', async () => {
    const ctx = setup();
    await start(ctx);
    await ctx.service.startDiagnosis(42, { mechanicName: 'Ana' });
    await start(ctx);
    expect(ctx.bus.last('ExecutionQueued').payload).toMatchObject({ status: 'DIAGNOSING', queuePosition: null });
  });

  it('capacidade esgotada → ExecutionRejected (saga vai estornar)', async () => {
    const ctx = setup({ maxActiveExecutions: 1 });
    await start(ctx, 1);
    await start(ctx, 2);
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionRejected', orderId: 2, payload: { reason: expect.stringContaining('Capacidade máxima') } });
  });

  it('OS sem serviços → ExecutionRejected; erro inesperado propaga', async () => {
    const ctx = setup();
    await start(ctx, 42, startPayload({ services: [] }));
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionRejected', payload: { reason: expect.stringContaining('ao menos um serviço') } });

    ctx.repository.create = async () => { throw new Error('dynamo down'); };
    await expect(start(ctx, 43)).rejects.toThrow('dynamo down');
  });

  it('corrida entre réplicas: usa o item que a outra criou', async () => {
    const ctx = setup();
    const original = ctx.repository.get.bind(ctx.repository);
    let first = true;
    ctx.repository.get = async (id) => (first ? (first = false, null) : original(id));
    await ctx.repository.create(Execution.create({ orderId: 42, sagaId: 'outra', services: startPayload().services }));
    await start(ctx);
    expect(ctx.bus.last().type).toBe('ExecutionQueued');
  });

  it('sem replyTo usa a fila padrão; comando desconhecido é ignorado', async () => {
    const ctx = setup();
    await ctx.service.handleCommand(command('StartExecution', startPayload(), { replyTo: undefined }));
    expect(ctx.bus.last().queue).toBe('default-replies');
    await expect(ctx.service.handleCommand(command('Xpto'))).resolves.toEqual({ outcome: 'UNHANDLED_TYPE' });
  });
});

describe('Ações do mecânico → eventos para a saga', () => {
  it('diagnóstico → reparo → conclusão publica cada etapa', async () => {
    const ctx = setup();
    await start(ctx);
    await ctx.service.startDiagnosis(42, { mechanicName: 'Roberto' });
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionStatusChanged', payload: { status: 'DIAGNOSING', mechanicName: 'Roberto' }, sagaId: 'saga-1' });
    await ctx.service.startRepair(42, { diagnosisNotes: 'Filtro saturado' });
    expect(ctx.bus.last().payload).toEqual({ status: 'REPAIRING', mechanicName: 'Roberto', notes: 'Filtro saturado' });
    const done = await ctx.service.complete(42, { notes: 'ok' });
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionCompleted', payload: { notes: 'ok', mechanicName: 'Roberto' } });
    expect(done.outbox).toEqual([]);
    expect((await ctx.service.get(42)).timeline.map((t) => t.status)).toEqual(['QUEUED', 'DIAGNOSING', 'REPAIRING', 'COMPLETED']);
  });

  it('reparo sem notas e conclusão sem notas publicam null', async () => {
    const ctx = setup();
    await start(ctx);
    await ctx.service.startDiagnosis(42, { mechanicName: 'Ana' });
    await ctx.service.startRepair(42, {});
    expect(ctx.bus.last().payload.notes).toBeNull();
    await ctx.service.complete(42, {});
    expect(ctx.bus.last().payload.notes).toBeNull();
  });

  it('falha publica ExecutionFailed com o motivo', async () => {
    const ctx = setup();
    await start(ctx);
    await ctx.service.fail(42, { reason: 'peça incompatível' });
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionFailed', payload: { reason: 'peça incompatível' } });
  });

  it('transição inválida, dados faltando e OS inexistente', async () => {
    const ctx = setup();
    await expect(ctx.service.complete(99, {})).resolves.toBeNull();
    await start(ctx);
    await expect(ctx.service.complete(42, {})).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(ctx.service.startDiagnosis(42, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(ctx.service.fail(42, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('SQS fora do ar: evento fica no outbox e é republicado depois', async () => {
    const ctx = setup();
    await start(ctx);
    ctx.bus.failNext = 1;
    const execution = await ctx.service.startDiagnosis(42, { mechanicName: 'Roberto' });
    expect(execution.status).toBe('DIAGNOSING');
    expect((await ctx.repository.get(42)).outbox).toHaveLength(1);
    expect(ctx.bus.last().type).toBe('ExecutionQueued');

    await expect(ctx.service.republishPendingEvents()).resolves.toBe(1);
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionStatusChanged', payload: { status: 'DIAGNOSING' } });
    expect((await ctx.repository.get(42)).outbox).toHaveLength(0);
    await expect(ctx.service.republishPendingEvents()).resolves.toBe(0);
  });

  it('erro ao republicar uma execução não interrompe as demais', async () => {
    const ctx = setup();
    ctx.repository.listWithPendingOutbox = async () => [{ outbox: [{}], orderId: 1 }];
    ctx.service.flushOutbox = async () => { throw new Error('conflito'); };
    await expect(ctx.service.republishPendingEvents()).resolves.toBe(0);
  });
});

describe('CancelExecution (compensação)', () => {
  it('cancela execução ativa e confirma; repetição é idempotente', async () => {
    const ctx = setup();
    await start(ctx);
    await ctx.service.handleCommand(command('CancelExecution', { reason: 'cliente desistiu' }));
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionCancelled', payload: { status: 'CANCELLED' } });
    expect((await ctx.service.get(42)).failureReason).toBe('cliente desistiu');
    await ctx.service.handleCommand(command('CancelExecution', {}));
    expect(ctx.bus.last().type).toBe('ExecutionCancelled');
  });

  it('confirma mesmo sem execução (nada a desfazer)', async () => {
    const ctx = setup();
    await ctx.service.handleCommand(command('CancelExecution', {}));
    expect(ctx.bus.last()).toMatchObject({ type: 'ExecutionCancelled', payload: { status: null } });
  });
});

describe('Consultas', () => {
  it('fila FIFO com posição, listagem por status e detalhe', async () => {
    const ctx = setup();
    await start(ctx, 1);
    await start(ctx, 2);
    await ctx.service.startDiagnosis(1, { mechanicName: 'Ana' });
    expect((await ctx.service.queue()).map((e) => [e.position, e.orderId])).toEqual([[1, 2]]);
    expect(await ctx.service.list({ status: 'DIAGNOSING' })).toHaveLength(1);
    expect(await ctx.service.list()).toHaveLength(2);
    expect(await ctx.service.get(1)).toMatchObject({ status: 'DIAGNOSING', pendingEvents: 0 });
    expect(await ctx.service.get(1)).not.toHaveProperty('outbox');
    await expect(ctx.service.get(9)).resolves.toBeNull();
  });

  it('relógio padrão', () => {
    expect(new ExecutionService({}).clock()).toBeInstanceOf(Date);
  });
});
