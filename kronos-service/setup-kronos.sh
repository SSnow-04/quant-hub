#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
[ -d vendor/Kronos ] || git clone --depth 1 https://github.com/shiyu-coder/Kronos.git vendor/Kronos
echo "Kronos setup complete. Run ./start-kronos.sh"
