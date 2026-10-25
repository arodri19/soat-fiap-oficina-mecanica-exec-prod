locals {
  prefix = "${var.project_name}-${var.environment}"
}

# Banco NoSQL próprio do exec-prod-service:
#   pk = EXECUTION#<orderId> (1 item por OS, linha do tempo aninhada no documento)
#   gsi1 (gsi1pk = STATUS#<status>, gsi1sk = queuedAt) → fila FIFO por status
#   gsi2 (gsi2pk = OUTBOX) → índice ESPARSO: só itens com evento pendente de publicação
resource "aws_dynamodb_table" "executions" {
  name         = "${local.prefix}-executions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.environment == "prod"
  }

  server_side_encryption {
    enabled = true
  }
}
