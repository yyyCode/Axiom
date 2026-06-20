#!/bin/bash
echo "⚡ Axiom Agent Server — DeepSeek Mode"
echo

export PROVIDER_TYPE=deepseek
export DEEPSEEK_API_KEY=your-deepseek-api-key-here
export MODEL=deepseek-v4-flash
export PORT=3000
export DATA_DIR=./data

echo "Provider: $PROVIDER_TYPE"
echo "Model:    $MODEL"
echo "Port:     $PORT"
echo

node dist/start.js
