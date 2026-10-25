# language: pt
Funcionalidade: Fila de execução da OS na saga
  Como exec-prod-service, participante da saga orquestrada pelo os-service
  Quero receber as OS pagas, conduzir diagnóstico e reparo e avisar a saga
  Para que o os-service acompanhe o status e compense quando a execução falhar

  Contexto:
    Dado que a oficina comporta 2 OS simultâneas

  Cenário: OS paga percorre diagnóstico, reparo e finalização
    Quando o os-service envia "StartExecution" para a OS 10
    Então a saga recebe "ExecutionQueued" na posição 1 da fila
    Quando o mecânico "Roberto" inicia o diagnóstico da OS 10
    Então a saga recebe "ExecutionStatusChanged" com status "DIAGNOSING"
    Quando o mecânico inicia o reparo da OS 10
    Então a saga recebe "ExecutionStatusChanged" com status "REPAIRING"
    Quando o mecânico finaliza a OS 10
    Então a saga recebe "ExecutionCompleted"
    E a execução da OS 10 fica "COMPLETED"

  Cenário: Oficina lotada recusa a OS para a saga estornar o pagamento
    Quando o os-service envia "StartExecution" para a OS 10
    E o os-service envia "StartExecution" para a OS 11
    E o os-service envia "StartExecution" para a OS 12
    Então a saga recebe "ExecutionRejected"

  Cenário: Cancelamento como compensação libera a vaga
    Quando o os-service envia "StartExecution" para a OS 10
    E o os-service envia "CancelExecution" para a OS 10
    Então a saga recebe "ExecutionCancelled"
    E a execução da OS 10 fica "CANCELLED"

  Cenário: Falha no reparo é reportada à saga
    Quando o os-service envia "StartExecution" para a OS 10
    E o mecânico "Ana" inicia o diagnóstico da OS 10
    E o mecânico reporta falha na OS 10 por "peça indisponível no fornecedor"
    Então a saga recebe "ExecutionFailed"
    E a execução da OS 10 fica "FAILED"
