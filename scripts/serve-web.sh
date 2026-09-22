#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
printf 'Teenio Web: http://localhost:8080\n'
python3 -m http.server 8080 --directory Web
