#!/bin/sh
# Filas e tabela do exec-prod no LocalStack (mesmos nomes do Terraform).
set -eu
P="oficina-mecanica-dev"
for q in execution-commands os-saga-replies; do
  awslocal sqs create-queue --queue-name "$P-$q-dlq" >/dev/null
  awslocal sqs create-queue --queue-name "$P-$q" >/dev/null
done
awslocal dynamodb create-table --table-name "$P-executions" --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=gsi1pk,AttributeType=S AttributeName=gsi1sk,AttributeType=S AttributeName=gsi2pk,AttributeType=S AttributeName=gsi2sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --global-secondary-indexes '[{"IndexName":"gsi1","KeySchema":[{"AttributeName":"gsi1pk","KeyType":"HASH"},{"AttributeName":"gsi1sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},{"IndexName":"gsi2","KeySchema":[{"AttributeName":"gsi2pk","KeyType":"HASH"},{"AttributeName":"gsi2sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' >/dev/null
echo "exec-prod: filas e tabela criadas"
