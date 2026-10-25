const { Execution, ExecutionStatus, ACTIVE_STATUSES } = require('../domain/Execution');
const { ValidationError } = require('../domain/errors');
const { Commands, Replies, createReply } = require('./contracts');

/**
 * Participante da saga responsável pela fila de execução da oficina.
 *
 * - Comandos do orquestrador (SQS): StartExecution / CancelExecution — respondidos
 *   diretamente na fila da saga (handlers idempotentes; erro → SQS reentrega).
 * - Ações do mecânico (HTTP): diagnóstico, reparo, conclusão, falha — o evento para
 *   a saga é gravado no `outbox` da PRÓPRIA execução, na mesma escrita do novo
 *   status (DynamoDB: escrita de item único é atômica), e publicado em seguida.
 *   Se o SQS falhar nesse momento, o OutboxPublisher reenvia depois — o os-service
 *   nunca deixa de saber que o serviço foi finalizado.
 */
class ExecutionService {
  constructor({ repository, messageBus, defaultReplyQueue, maxActiveExecutions = 10, monitoring, tracing, logger, clock }) {
    this.repository = repository;
    this.messageBus = messageBus;
    this.defaultReplyQueue = defaultReplyQueue;
    this.maxActiveExecutions = maxActiveExecutions;
    this.monitoring = monitoring;
    this.tracing = tracing;
    this.logger = logger;
    this.clock = clock || (() => new Date());

    this.handlers = {
      [Commands.START_EXECUTION]: this.startExecution.bind(this),
      [Commands.CANCEL_EXECUTION]: this.cancelExecution.bind(this)
    };
  }

  async handleCommand(command) {
    const handler = this.handlers[command.type];
    if (!handler) {
      this.logger.warn({ type: command.type }, 'Comando desconhecido — ignorado');
      return { outcome: 'UNHANDLED_TYPE' };
    }
    return handler(command);
  }

  // ── StartExecution: entra na fila (se houver capacidade) ────────────────────
  async startExecution(command) {
    const { orderId } = command;
    const existing = await this.repository.get(orderId);
    if (existing) {
      // Reentrega do comando: responde de novo com o mesmo resultado
      return existing.status === ExecutionStatus.CANCELLED
        ? this.#reply(command, Replies.EXECUTION_REJECTED, { reason: 'Execução já cancelada para esta OS' })
        : this.#reply(command, Replies.EXECUTION_QUEUED, await this.#queuedPayload(existing));
    }

    // Capacidade da oficina: limite de OS simultâneas (fila + em andamento).
    // Acima disso a saga recebe ExecutionRejected e compensa (estorno do pagamento).
    const active = await this.repository.countByStatuses(ACTIVE_STATUSES);
    if (active >= this.maxActiveExecutions) {
      this.monitoring.recordExecutionEvent('ExecutionStatusChanged', { orderId, status: 'REJECTED', active });
      return this.#reply(command, Replies.EXECUTION_REJECTED, {
        reason: `Capacidade máxima da oficina atingida (${active}/${this.maxActiveExecutions} OS em execução)`
      });
    }

    let execution;
    try {
      execution = Execution.create({
        orderId,
        sagaId: command.sagaId,
        replyTo: command.replyTo,
        externalId: command.payload.externalId,
        description: command.payload.description,
        vehicle: command.payload.vehicle,
        services: command.payload.services,
        now: this.clock()
      });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return this.#reply(command, Replies.EXECUTION_REJECTED, { reason: error.message });
    }

    const created = await this.repository.create(execution);
    const stored = created ? execution : await this.repository.get(orderId);
    this.monitoring.recordExecutionEvent('ExecutionStatusChanged', { orderId, status: stored.status });
    return this.#reply(command, Replies.EXECUTION_QUEUED, await this.#queuedPayload(stored));
  }

  // ── CancelExecution (compensação) ───────────────────────────────────────────
  async cancelExecution(command) {
    const execution = await this.repository.get(command.orderId);
    if (execution?.cancel(command.payload.reason || 'Compensação da saga', this.clock())) {
      await this.repository.save(execution);
      this.monitoring.recordExecutionEvent('ExecutionStatusChanged', { orderId: execution.orderId, status: execution.status });
    }
    return this.#reply(command, Replies.EXECUTION_CANCELLED, { status: execution?.status || null });
  }

  // ── Ações do mecânico (HTTP) ────────────────────────────────────────────────
  async startDiagnosis(orderId, { mechanicName }) {
    return this.#act(orderId, (execution) => execution.startDiagnosis(mechanicName, this.clock()), (execution) => ({
      type: Replies.EXECUTION_STATUS_CHANGED,
      payload: { status: ExecutionStatus.DIAGNOSING, mechanicName: execution.mechanicName }
    }));
  }

  async startRepair(orderId, { diagnosisNotes }) {
    return this.#act(orderId, (execution) => execution.startRepair(diagnosisNotes, this.clock()), (execution) => ({
      type: Replies.EXECUTION_STATUS_CHANGED,
      payload: { status: ExecutionStatus.REPAIRING, mechanicName: execution.mechanicName, notes: diagnosisNotes || null }
    }));
  }

  async complete(orderId, { notes }) {
    return this.#act(orderId, (execution) => execution.complete(notes, this.clock()), (execution) => ({
      type: Replies.EXECUTION_COMPLETED,
      payload: { notes: notes || null, finishedAt: execution.finishedAt, mechanicName: execution.mechanicName }
    }));
  }

  async fail(orderId, { reason }) {
    return this.#act(orderId, (execution) => execution.fail(reason, this.clock()), () => ({
      type: Replies.EXECUTION_FAILED,
      payload: { reason }
    }));
  }

  async #act(orderId, mutate, buildEvent) {
    const execution = await this.repository.get(orderId);
    if (!execution) return null;

    mutate(execution);
    const { type, payload } = buildEvent(execution);
    execution.enqueueEvent(createReply({
      type,
      sagaId: execution.sagaId,
      orderId: execution.orderId,
      payload,
      traceHeaders: this.tracing.currentTraceHeaders()
    }));
    await this.repository.save(execution);
    this.monitoring.recordExecutionEvent('ExecutionStatusChanged', { orderId: execution.orderId, status: execution.status, mechanicName: execution.mechanicName });

    await this.flushOutbox(execution);
    return execution;
  }

  // Publica eventos pendentes de uma execução e limpa o outbox. Falha de
  // publicação não é propagada — o OutboxPublisher tenta de novo depois.
  async flushOutbox(execution) {
    const published = [];
    for (const event of execution.outbox) {
      try {
        await this.messageBus.publish(execution.replyTo || this.defaultReplyQueue, event);
        published.push(event.messageId);
      } catch (error) {
        this.logger.warn({ err: error, orderId: execution.orderId, type: event.type }, 'Evento ficou no outbox — será republicado');
        break;
      }
    }
    if (published.length) {
      execution.clearOutbox(published);
      await this.repository.save(execution);
    }
    return published.length;
  }

  async republishPendingEvents() {
    let total = 0;
    for (const execution of await this.repository.listWithPendingOutbox()) {
      try {
        total += await this.flushOutbox(execution);
      } catch (error) {
        this.logger.warn({ err: error, orderId: execution.orderId }, 'Falha ao republicar outbox');
      }
    }
    return total;
  }

  // ── Consultas ───────────────────────────────────────────────────────────────
  async get(orderId) {
    const execution = await this.repository.get(orderId);
    return execution ? toView(execution) : null;
  }

  async list({ status } = {}) {
    const statuses = status ? [status] : Object.values(ExecutionStatus);
    const executions = (await Promise.all(statuses.map((s) => this.repository.listByStatus(s)))).flat();
    return executions.map(toView);
  }

  // Fila de execução: OS aguardando um mecânico, da mais antiga para a mais nova.
  async queue() {
    const queued = await this.repository.listByStatus(ExecutionStatus.QUEUED);
    return queued.map((execution, index) => ({ position: index + 1, ...toView(execution) }));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  async #queuedPayload(execution) {
    let queuePosition = null;
    if (execution.status === ExecutionStatus.QUEUED) {
      const queued = await this.repository.listByStatus(ExecutionStatus.QUEUED);
      queuePosition = queued.findIndex((e) => e.orderId === execution.orderId) + 1 || queued.length;
    }
    return { executionId: execution.executionId, status: execution.status, queuePosition, estimatedMinutes: execution.estimatedMinutes };
  }

  async #reply(command, type, payload) {
    const reply = createReply({
      type,
      sagaId: command.sagaId,
      orderId: command.orderId,
      correlationId: command.correlationId,
      payload,
      traceHeaders: this.tracing.currentTraceHeaders()
    });
    await this.messageBus.publish(command.replyTo || this.defaultReplyQueue, reply);
    return { outcome: type };
  }
}

function toView(execution) {
  const { outbox, version, ...view } = execution;
  return { ...view, pendingEvents: outbox.length };
}

module.exports = { ExecutionService };
