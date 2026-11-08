#!/bin/bash
# Solo DJ をダブルクリックで起動する (macOS)。
# Finder でこのファイルをダブルクリックすると、サーバが立ち上がって
# ブラウザが開く。止めるときはこのターミナルウィンドウを閉じるか Ctrl+C。

cd "$(dirname "$0")" || exit 1

alert() {
  # ターミナルにも出しつつ、見落とさないようダイアログでも知らせる。
  echo "$1"
  osascript -e "display alert \"Solo DJ\" message \"$1\"" >/dev/null 2>&1
}

if ! command -v node >/dev/null 2>&1; then
  alert "Node.js が見つかりません。ターミナルで brew install node を実行してから、もう一度ダブルクリックしてください。"
  exit 1
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 20 ]; then
  alert "Node.js $MAJOR は古すぎます。20 以上が必要です。brew upgrade node を実行してください。"
  exit 1
fi

PORT="${PORT:-8787}"

# サーバが応答し始めてからブラウザを開く (先に開くと接続できない画面が出る)。
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
      open "http://127.0.0.1:$PORT/"
      exit 0
    fi
    sleep 0.25
  done
) &

PORT="$PORT" exec node server.mjs
