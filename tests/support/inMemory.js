const crypto = require('node:crypto');
const { Execution } = require('../../src/domain/Execution');
const { ConcurrencyError } = require('../../src/infrastructure/persistence/DynamoExecutionRepository');

// Mesma interface e regras (criação única, lock otimista) do DynamoExecutionRepository.
class InMemoryExecutionRepository {
  constructor() {
    this.items = new Map();
  }

  async create(execution) {
    if (this.items.has(execution.orderId)) return false;
    this.items.set(execution.orderId, structuredClone({ ...execution }));
    return true;
  }

  async get(orderId) {
    const row = this.items.get(Number(orderId));
    return row ? new Execution(structuredClone(row)) : null;
  }

  async save(execution) {
    const current = this.items.get(execution.orderId);
    if (!current || current.version !== execution.version) throw new ConcurrencyError('execution');
    execution.version += 1;
    this.items.set(execution.orderId, structuredClone({ ...execution }));
  }

  async listByStatus(status) {
    return [...this.items.values()]
      .filter((e) => e.status === status)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .map((e) => new Execution(structuredClone(e)));
  }

  async countByStatuses(statuses) {
    return [...this.items.values()].filter((e) => statuses.includes(e.status)).length;
  }

  async listWithPendingOutbox() {
    return [...this.items.values()].filter((e) => e.outbox.length).map((e) => new Execution(structuredClone(e)));
  }
}

class RecordingBus {
  constructor() {
    this.published = [];
    this.failNext = 0;
  }

  async publish(queue, envelope) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('SQS indisponível');
    }
    this.published.push({ queue, ...envelope });
  }

  last(type) {
    return [...this.published].reverse().find((m) => !type || m.type === type);
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };
const fakeTracing = { currentTraceHeaders: () => ({ traceparent: '00-exec' }) };
const fakeMonitoring = () => ({ events: [], recordExecutionEvent(type, attrs) { this.events.push({ type, ...attrs }); } });

const SERVICES = [{ serviceId: 1, name: 'Troca de Óleo', slaMinutes: 60, parts: [{ partId: 1, name: 'Óleo', quantity: 2 }] }];

function command(type, payload = {}, overrides = {}) {
  return {
    messageId: crypto.randomUUID(), type, sagaId: 'saga-1', orderId: 42, correlationId: 'saga-1',
    replyTo: 'os-replies', source: 'os-service', payload, ...overrides
  };
}

const startPayload = (overrides = {}) => ({
  externalId: 'ext-1', description: 'Troca de óleo', vehicle: { plate: 'ABC1D23', model: 'Pulse' }, services: SERVICES, ...overrides
});

module.exports = { InMemoryExecutionRepository, RecordingBus, silentLogger, fakeTracing, fakeMonitoring, command, startPayload, SERVICES };
