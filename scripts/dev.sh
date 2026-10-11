#!/bin/zsh
# 手元の模擬環境(エミュレータ)を起動する。本番には一切触れない
#   画面:       http://127.0.0.1:5050
#   管理画面:   http://127.0.0.1:4000
# 起動後に別のターミナルで scripts/seed-emulator.sh を1回実行する
export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
cd "$(dirname "$0")/.."
exec firebase emulators:start --project demo-juku-qa
