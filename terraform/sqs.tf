# Fila de comandos do exec-prod (StartExecution, CancelExecution) —
# publicada pelo orquestrador do os-service.
resource "aws_sqs_queue" "commands_dlq" {
  name                      = "${local.prefix}-execution-commands-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "commands" {
  name                       = "${local.prefix}-execution-commands"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.commands_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "commands_dlq" {
  queue_url = aws_sqs_queue.commands_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.commands.arn]
  })
}
