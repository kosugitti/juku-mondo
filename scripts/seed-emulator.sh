#!/bin/zsh
# 模擬環境に幹事の許可リストを入れる(ルールを素通りする管理者権限で書く)
#   使い方: scripts/seed-emulator.sh [メールアドレス ...]
emails=(${@:-organizer@example.com})
vals=$(printf '{"stringValue":"%s"},' "${emails[@]}")
curl -s -X PATCH \
  "http://127.0.0.1:8080/v1/projects/demo-juku-qa/databases/(default)/documents/config/organizers" \
  -H "Authorization: Bearer owner" -H "Content-Type: application/json" \
  -d "{\"fields\":{\"emails\":{\"arrayValue\":{\"values\":[${vals%,}]}}}}" > /dev/null \
  && echo "幹事として登録: ${emails[*]}"
