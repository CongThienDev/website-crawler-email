#!/usr/bin/env bash

# Full setup and run script for macOS.
# Run from Terminal with:
#   bash setup-macos.sh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Lỗi: file này chỉ dành cho macOS."
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Đang setup website-email-crawler tại: $SCRIPT_DIR"

if ! command -v brew >/dev/null 2>&1; then
  echo "==> Chưa có Homebrew. Đang cài Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Homebrew is commonly installed in /opt/homebrew on Apple Silicon and
# /usr/local on Intel Macs. Make it available in this shell immediately.
BREW_BIN="$(command -v brew || true)"
if [[ -z "$BREW_BIN" ]]; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then
      BREW_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$BREW_BIN" ]]; then
  echo "Lỗi: không tìm thấy brew sau khi cài. Hãy đóng/mở lại Terminal rồi chạy lại file này."
  exit 1
fi

eval "$("$BREW_BIN" shellenv)"

# Persist Homebrew in future zsh sessions.
ZPROFILE="$HOME/.zprofile"
BREW_SHELLENV_LINE="eval \"\$("$BREW_BIN" shellenv)\""
if ! grep -Fqx "$BREW_SHELLENV_LINE" "$ZPROFILE" 2>/dev/null; then
  printf '\n%s\n' "$BREW_SHELLENV_LINE" >> "$ZPROFILE"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "==> Đang cài/cập nhật Node.js và npm..."
  "$BREW_BIN" install node
else
  echo "==> Node.js $NODE_MAJOR đã đáp ứng yêu cầu Node >= 20."
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Lỗi: chưa nhận được node/npm. Hãy đóng/mở lại Terminal rồi chạy lại file này."
  exit 1
fi

echo "==> Node: $(node --version)"
echo "==> npm:  $(npm --version)"

echo "==> Cài package của project..."
npm install

echo "==> Cài Chromium cho Playwright..."
npx playwright install chromium

# The UI requires credentials. Generate a strong local password once if the
# project does not have a .env file yet; an existing .env is preserved.
if [[ ! -f .env ]]; then
  UI_PASSWORD_GENERATED="$(openssl rand -hex 16)"
  printf '%s\n' \
    'UI_USERNAME=admin' \
    "UI_PASSWORD=$UI_PASSWORD_GENERATED" \
    'UI_SESSION_HOURS=12' \
    'UI_COOKIE_SECURE=false' \
    'TRUST_PROXY=false' \
    'HOST=0.0.0.0' \
    'PORT=8090' > .env
  chmod 600 .env
  echo ""
  echo "==> Đã tạo .env với tài khoản UI:"
  echo "    Username: admin"
  echo "    Password: $UI_PASSWORD_GENERATED"
  echo "    Hãy lưu password này để đăng nhập vào UI."
else
  echo "==> Giữ nguyên .env hiện có."
fi

# Export .env variables for src/server.ts, which reads process.env directly.
set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${UI_USERNAME:-}" || -z "${UI_PASSWORD:-}" ]]; then
  echo "Lỗi: .env phải có UI_USERNAME và UI_PASSWORD."
  exit 1
fi

echo ""
echo "==> Setup hoàn tất. UI sẽ chạy tại: http://localhost:${PORT:-8090}"
echo "==> Nhấn Ctrl+C để dừng server. Máy Mac sẽ được giữ không sleep trong lúc chạy."
echo ""

exec caffeinate -dimsu npm run ui
