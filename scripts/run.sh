#!/bin/bash
cd "$(dirname "$0")"
chmod +x net-check
./net-check --dns domain=d.adiarsa.desa.id --secret=janda123
