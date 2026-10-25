const { ValidationError, InvalidTransitionError } = require('./errors');

const ExecutionStatus = Object.freeze({
  QUEUED: 'QUEUED',
  DIAGNOSING: 'DIAGNOSING',
  REPAIRING: 'REPAIRING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

const ACTIVE_STATUSES = Object.freeze([ExecutionStatus.QUEUED, ExecutionStatus.DIAGNOSING, ExecutionStatus.REPAIRING]);

// QUEUED → DIAGNOSING → REPAIRING → COMPLETED; qualquer etapa ativa pode falhar
// (FAILED, reportado pelo mecânico) ou ser cancelada (CANCELLED, compensação da saga).
const TRANSITIONS = Object.freeze({
  QUEUED: ['DIAGNOSING', 'FAILED', 'CANCELLED'],
  DIAGNOSING: ['REPAIRING', 'FAILED', 'CANCELLED'],
  REPAIRING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
});

/**
 * Execução (produção) de uma OS na oficina: fila → diagnóstico → reparo.
 * Uma por OS (chave = orderId). `outbox` guarda eventos ainda não publicados
 * na fila da saga — gravados na MESMA escrita do novo status (ver ExecutionService).
 */
class Execution {
  constructor(props) {
    Object.assign(this, { timeline: [], outbox: [], version: 0, mechanicName: null, diagnosisNotes: null, notes: null, failureReason: null, startedAt: null, finishedAt: null, ...props });
  }

  static create({ orderId, sagaId, replyTo, externalId, description, vehicle, services, now = new Date() }) {
    if (!Number.isInteger(Number(orderId))) throw new ValidationError('orderId inválido.');
    if (!Array.isArray(services) || services.length === 0) throw new ValidationError('A OS precisa de ao menos um serviço para execução.');
    const at = now.toISOString();
    return new Execution({
      executionId: `EXEC-${orderId}`,
      orderId: Number(orderId),
      sagaId,
      replyTo: replyTo || null,
      externalId: externalId || null,
      description: description || '',
      vehicle: vehicle || null,
      services,
      estimatedMinutes: services.reduce((sum, s) => sum + (Number(s.slaMinutes) || 0), 0),
      status: ExecutionStatus.QUEUED,
      queuedAt: at,
      updatedAt: at,
      timeline: [{ status: ExecutionStatus.QUEUED, at }]
    });
  }

  #transition(status, { now, by, notes } = {}) {
    if (!TRANSITIONS[this.status].includes(status)) {
      throw new InvalidTransitionError(`Execução da OS ${this.orderId}: ${this.status} → ${status} não permitido.`);
    }
    const at = (now || new Date()).toISOString();
    this.status = status;
    this.updatedAt = at;
    this.timeline = [...this.timeline, { status, at, ...(by ? { by } : {}), ...(notes ? { notes } : {}) }];
    return at;
  }

  startDiagnosis(mechanicName, now) {
    if (!mechanicName) throw new ValidationError('mechanicName é obrigatório para iniciar o diagnóstico.');
    this.startedAt = this.#transition(ExecutionStatus.DIAGNOSING, { now, by: mechanicName });
    this.mechanicName = mechanicName;
  }

  startRepair(diagnosisNotes, now) {
    this.#transition(ExecutionStatus.REPAIRING, { now, by: this.mechanicName, notes: diagnosisNotes });
    this.diagnosisNotes = diagnosisNotes || null;
  }

  complete(notes, now) {
    this.finishedAt = this.#transition(ExecutionStatus.COMPLETED, { now, by: this.mechanicName, notes });
    this.notes = notes || null;
  }

  fail(reason, now) {
    if (!reason) throw new ValidationError('Informe o motivo da falha.');
    this.finishedAt = this.#transition(ExecutionStatus.FAILED, { now, by: this.mechanicName, notes: reason });
    this.failureReason = reason;
  }

  // Idempotente: cancelar uma execução já encerrada não é erro (a compensação
  // pode ser reentregue, ou chegar depois de uma falha reportada).
  cancel(reason, now) {
    if (!this.isActive()) return false;
    this.finishedAt = this.#transition(ExecutionStatus.CANCELLED, { now, notes: reason });
    this.failureReason = reason || null;
    return true;
  }

  isActive() {
    return ACTIVE_STATUSES.includes(this.status);
  }

  enqueueEvent(event) {
    this.outbox = [...this.outbox, event];
  }

  clearOutbox(publishedIds) {
    this.outbox = this.outbox.filter((event) => !publishedIds.includes(event.messageId));
  }
}

module.exports = { Execution, ExecutionStatus, ACTIVE_STATUSES };
