const { Execution, ExecutionStatus, ACTIVE_STATUSES } = require('../../src/domain/Execution');
const { ValidationError, InvalidTransitionError } = require('../../src/domain/errors');
const { SERVICES } = require('../support/inMemory');

const create = (overrides = {}) => Execution.create({ orderId: '7', sagaId: 's', services: SERVICES, ...overrides });

describe('Execution', () => {
  it('nasce na fila com estimativa a partir do SLA dos serviços', () => {
    const execution = create({ services: [{ slaMinutes: 30 }, { slaMinutes: '45' }, {}] });
    expect(execution).toMatchObject({ executionId: 'EXEC-7', orderId: 7, status: 'QUEUED', estimatedMinutes: 75, replyTo: null, vehicle: null, description: '' });
    expect(execution.isActive()).toBe(true);
    expect(ACTIVE_STATUSES).toContain(ExecutionStatus.QUEUED);
  });

  it('valida orderId e serviços', () => {
    expect(() => create({ orderId: 'x' })).toThrow(ValidationError);
    expect(() => create({ services: [] })).toThrow(/ao menos um serviço/);
    expect(() => create({ services: null })).toThrow(ValidationError);
  });

  it('fluxo completo registra linha do tempo com mecânico e notas', () => {
    const execution = create();
    execution.startDiagnosis('Ana');
    execution.startRepair('pastilha gasta');
    execution.complete('ok');
    expect(execution).toMatchObject({ status: 'COMPLETED', mechanicName: 'Ana', diagnosisNotes: 'pastilha gasta', notes: 'ok' });
    expect(execution.startedAt).toBeTruthy();
    expect(execution.finishedAt).toBeTruthy();
    expect(execution.timeline[1]).toMatchObject({ status: 'DIAGNOSING', by: 'Ana' });
    expect(execution.isActive()).toBe(false);
  });

  it('notas opcionais ficam nulas', () => {
    const execution = create();
    execution.startDiagnosis('Ana');
    execution.startRepair();
    execution.complete();
    expect(execution).toMatchObject({ diagnosisNotes: null, notes: null });
    expect(execution.timeline[2]).not.toHaveProperty('notes');
  });

  it('transições inválidas', () => {
    const execution = create();
    expect(() => execution.startRepair()).toThrow(InvalidTransitionError);
    expect(() => execution.complete()).toThrow(/QUEUED → COMPLETED/);
    execution.fail('motivo');
    expect(execution.failureReason).toBe('motivo');
    expect(() => execution.startDiagnosis('Ana')).toThrow(InvalidTransitionError);
  });

  it('cancelamento só de execução ativa (idempotente)', () => {
    const execution = create();
    expect(execution.cancel()).toBe(true);
    expect(execution.failureReason).toBeNull();
    expect(execution.cancel('de novo')).toBe(false);
  });

  it('outbox: enfileira e limpa só os publicados', () => {
    const execution = create();
    execution.enqueueEvent({ messageId: 'a' });
    execution.enqueueEvent({ messageId: 'b' });
    execution.clearOutbox(['a']);
    expect(execution.outbox).toEqual([{ messageId: 'b' }]);
  });
});
