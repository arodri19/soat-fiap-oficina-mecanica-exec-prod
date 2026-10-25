const path = require('node:path');
const { loadFeature, defineFeature } = require('jest-cucumber');
const { ExecutionService } = require('../../src/application/ExecutionService');
const { InMemoryExecutionRepository, RecordingBus, silentLogger, fakeTracing, fakeMonitoring, command, startPayload } = require('../support/inMemory');

const feature = loadFeature(path.join(__dirname, 'features/fila-execucao.feature'));

defineFeature(feature, (test) => {
  let ctx;

  const background = (given) => given(/^que a oficina comporta (\d+) OS simultâneas$/, (max) => {
    const repository = new InMemoryExecutionRepository();
    const bus = new RecordingBus();
    ctx = {
      repository,
      bus,
      service: new ExecutionService({
        repository, messageBus: bus, defaultReplyQueue: 'replies', maxActiveExecutions: Number(max),
        monitoring: fakeMonitoring(), tracing: fakeTracing, logger: silentLogger
      })
    };
  });

  const steps = {
    comando: (fn) => fn(/^o os-service envia "(.*)" para a OS (\d+)$/, async (type, orderId) => {
      const payload = type === 'StartExecution' ? startPayload() : { reason: 'compensação' };
      await ctx.service.handleCommand(command(type, payload, { orderId: Number(orderId) }));
    }),
    diagnostico: (fn) => fn(/^o mecânico "(.*)" inicia o diagnóstico da OS (\d+)$/, (name, id) => ctx.service.startDiagnosis(Number(id), { mechanicName: name })),
    reparo: (fn) => fn(/^o mecânico inicia o reparo da OS (\d+)$/, (id) => ctx.service.startRepair(Number(id), { diagnosisNotes: 'confirmado' })),
    finaliza: (fn) => fn(/^o mecânico finaliza a OS (\d+)$/, (id) => ctx.service.complete(Number(id), { notes: 'ok' })),
    falha: (fn) => fn(/^o mecânico reporta falha na OS (\d+) por "(.*)"$/, (id, reason) => ctx.service.fail(Number(id), { reason })),
    posicao: (fn) => fn(/^a saga recebe "(.*)" na posição (\d+) da fila$/, (type, position) => {
      expect(ctx.bus.last()).toMatchObject({ type, payload: { queuePosition: Number(position) } });
    }),
    status: (fn) => fn(/^a saga recebe "(.*)" com status "(.*)"$/, (type, status) => {
      expect(ctx.bus.last()).toMatchObject({ type, payload: { status } });
    }),
    recebe: (fn) => fn(/^a saga recebe "(.*)"$/, (type) => {
      expect(ctx.bus.last().type).toBe(type);
    }),
    estado: (fn) => fn(/^a execução da OS (\d+) fica "(.*)"$/, async (id, status) => {
      expect((await ctx.service.get(Number(id))).status).toBe(status);
    })
  };

  test('OS paga percorre diagnóstico, reparo e finalização', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.posicao(then);
    steps.diagnostico(when);
    steps.status(then);
    steps.reparo(when);
    steps.status(then);
    steps.finaliza(when);
    steps.recebe(then);
    steps.estado(and);
  });

  test('Oficina lotada recusa a OS para a saga estornar o pagamento', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.comando(and);
    steps.comando(and);
    steps.recebe(then);
  });

  test('Cancelamento como compensação libera a vaga', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.comando(and);
    steps.recebe(then);
    steps.estado(and);
  });

  test('Falha no reparo é reportada à saga', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.diagnostico(and);
    steps.falha(and);
    steps.recebe(then);
    steps.estado(and);
  });
});
