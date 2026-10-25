const mockService = {
  list: jest.fn(), queue: jest.fn(), get: jest.fn(),
  startDiagnosis: jest.fn(), startRepair: jest.fn(), complete: jest.fn(), fail: jest.fn()
};
jest.mock('../../src/container', () => ({ getExecutionService: () => mockService }));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const config = require('../../src/config');
const app = require('../../src/app');

const token = (role) => `Bearer ${jwt.sign({ sub: 1, role }, config.JWT_SECRET)}`;
const mechanic = token('MECHANIC');

describe('Rotas do exec-prod', () => {
  it('health e swagger', async () => {
    expect((await request(app).get('/health')).body.service).toBe('exec-prod-service');
    await request(app).get('/api-docs/').expect(200);
  });

  it('consultas exigem funcionário', async () => {
    await request(app).get('/api/executions').expect(401);
    await request(app).get('/api/executions').set('Authorization', token('CLIENT')).expect(403);
    mockService.list.mockResolvedValue([]);
    await request(app).get('/api/executions?status=QUEUED').set('Authorization', mechanic).expect(200);
    expect(mockService.list).toHaveBeenCalledWith({ status: 'QUEUED' });
    mockService.queue.mockResolvedValue([{ position: 1 }]);
    expect((await request(app).get('/api/executions/queue').set('Authorization', mechanic)).body).toEqual([{ position: 1 }]);
  });

  it('GET por OS → 200/404', async () => {
    mockService.get.mockResolvedValueOnce({ orderId: 42 });
    await request(app).get('/api/executions/42').set('Authorization', mechanic).expect(200);
    mockService.get.mockResolvedValueOnce(null);
    await request(app).get('/api/executions/43').set('Authorization', mechanic).expect(404);
  });

  it.each([
    ['diagnosis/start', 'startDiagnosis', { mechanicName: 'Ana' }, { mechanicName: 'Ana' }],
    ['repair/start', 'startRepair', { diagnosisNotes: 'x' }, { diagnosisNotes: 'x' }],
    ['complete', 'complete', { notes: 'ok' }, { notes: 'ok' }],
    ['fail', 'fail', { reason: 'r' }, { reason: 'r' }]
  ])('POST %s', async (path, fn, body, expected) => {
    mockService[fn].mockResolvedValueOnce({ orderId: 42, status: 'X', outbox: [], version: 3 });
    const res = await request(app).post(`/api/executions/42/${path}`).set('Authorization', mechanic).send(body).expect(200);
    expect(res.body).toEqual({ orderId: 42, status: 'X' });
    expect(mockService[fn]).toHaveBeenCalledWith(42, expected);
    mockService[fn].mockResolvedValueOnce(null);
    await request(app).post(`/api/executions/42/${path}`).set('Authorization', mechanic).expect(404);
  });

  it('erros de domínio → 400/409; inesperado → 500', async () => {
    mockService.complete.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'InvalidTransitionError' }));
    await request(app).post('/api/executions/42/complete').set('Authorization', mechanic).expect(409);
    mockService.fail.mockRejectedValueOnce(Object.assign(new Error('v'), { name: 'ValidationError' }));
    await request(app).post('/api/executions/42/fail').set('Authorization', mechanic).expect(400);
    mockService.get.mockRejectedValueOnce(new Error('boom'));
    await request(app).get('/api/executions/42').set('Authorization', mechanic).expect(500);
    await request(app).post('/api/executions/42/fail').set('Authorization', mechanic).set('Content-Type', 'application/json').send('{').expect(400);
  });

  it('rota interna só para JWT de serviço', async () => {
    mockService.get.mockResolvedValue({ orderId: 42 });
    await request(app).get('/api/internal/executions/42').set('Authorization', mechanic).expect(403);
    await request(app).get('/api/internal/executions/42').set('Authorization', token('SERVICE')).expect(200);
    mockService.get.mockResolvedValue(null);
    await request(app).get('/api/internal/executions/42').set('Authorization', token('SERVICE')).expect(404);
  });
});
