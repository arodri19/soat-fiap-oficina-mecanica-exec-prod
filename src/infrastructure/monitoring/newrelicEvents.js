const newrelic = require('newrelic');

// ExecutionStatusChanged — painel "Fila de execução" do dashboard (infra-kube).
function recordExecutionEvent(eventType, attributes) {
  newrelic.recordCustomEvent(eventType, { service: 'exec-prod-service', ...attributes });
}

module.exports = { recordExecutionEvent };
