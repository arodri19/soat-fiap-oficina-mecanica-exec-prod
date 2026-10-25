# Menor privilégio: consome só a própria fila, publica só na fila de respostas
# da saga e acessa só a própria tabela.
data "aws_iam_policy_document" "exec_prod" {
  statement {
    sid = "ConsumeExecutionCommands"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueUrl",
      "sqs:GetQueueAttributes"
    ]
    resources = [aws_sqs_queue.commands.arn]
  }

  statement {
    sid       = "PublishSagaReplies"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
    resources = ["arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${local.prefix}-os-saga-replies"]
  }

  statement {
    sid = "ExecutionsTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query"
    ]
    resources = [
      aws_dynamodb_table.executions.arn,
      "${aws_dynamodb_table.executions.arn}/index/*"
    ]
  }
}

resource "aws_iam_policy" "exec_prod" {
  name        = "${local.prefix}-exec-prod-service"
  description = "Acesso do exec-prod-service à sua fila SQS e tabela DynamoDB"
  policy      = data.aws_iam_policy_document.exec_prod.json
}

resource "aws_iam_role_policy_attachment" "exec_prod_nodes" {
  role       = data.terraform_remote_state.infra_kube.outputs.node_role_name
  policy_arn = aws_iam_policy.exec_prod.arn
}
