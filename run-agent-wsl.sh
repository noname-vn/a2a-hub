#!/bin/bash
# hermes-wsl A2A agent — wrapper tự restart (loop vĩnh viễn).
# Vốn dĩ client tự reconnect khi mất mạng; wrapper chỉ bắt trường hợp process CHẾT hẳn.
# Chạy: /opt/data/a2a-hub/run-agent-wsl.sh  (cron @reboot + systemd-less)
cd /opt/data/a2a-hub
KEY=$(cat /opt/data/a2a-hub/.key-hermes-wsl)
while true; do
  AGENT_NAME=hermes-wsl API_KEY="$KEY" node agent-ws-client.js ./handler-wsl.mjs >> /opt/data/a2a-hub/wsl-agent.log 2>&1
  echo "[$(date '+%F %T')] client thoát (code $?) — restart sau 5s" >> /opt/data/a2a-hub/wsl-agent.log
  sleep 5
done