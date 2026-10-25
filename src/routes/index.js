const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize } = require('../middlewares/auth');
const container = require('../container');

const router = express.Router();
const staff = [authenticate, authorize(['ATTENDANT', 'MECHANIC'])];
const mechanic = [authenticate, authorize(['MECHANIC', 'ATTENDANT'])];
const service = () => container.getExecutionService();
const orderIdOf = (req) => Number(req.params.orderId);

const notFound = (res) => res.status(404).json({ message: 'Execução não encontrada para esta OS.' });

router.get('/executions', ...staff, asyncHandler(async (req, res) => {
  res.json(await service().list({ status: req.query.status }));
}));

router.get('/executions/queue', ...staff, asyncHandler(async (req, res) => {
  res.json(await service().queue());
}));

router.get('/executions/:orderId', ...staff, asyncHandler(async (req, res) => {
  const execution = await service().get(orderIdOf(req));
  return execution ? res.json(execution) : notFound(res);
}));

// Ações do mecânico — cada uma notifica a saga (os-service) pela fila de respostas
const actions = {
  'diagnosis/start': (id, body) => service().startDiagnosis(id, { mechanicName: body.mechanicName }),
  'repair/start': (id, body) => service().startRepair(id, { diagnosisNotes: body.diagnosisNotes }),
  complete: (id, body) => service().complete(id, { notes: body.notes }),
  fail: (id, body) => service().fail(id, { reason: body.reason })
};

for (const [path, action] of Object.entries(actions)) {
  router.post(`/executions/:orderId/${path}`, ...mechanic, asyncHandler(async (req, res) => {
    const execution = await action(orderIdOf(req), req.body || {});
    if (!execution) return notFound(res);
    const { outbox, version, ...view } = execution;
    return res.json(view);
  }));
}

// REST síncrono para o os-service (JWT role SERVICE)
router.get('/internal/executions/:orderId', authenticate, authorize(['SERVICE']), asyncHandler(async (req, res) => {
  const execution = await service().get(orderIdOf(req));
  return execution ? res.json(execution) : notFound(res);
}));

module.exports = router;
