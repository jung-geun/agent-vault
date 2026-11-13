#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="jung-geun/agent-vault"
REF="${AGENT_VAULT_REF:-main}"
SCOPE="--global"

if [ "$#" -gt 0 ]; then
  case "$1" in
    --global|--local)
      SCOPE="$1"
      shift
      ;;
    *)
      echo "Usage: install.sh [--global|--local]" >&2
      exit 2
      ;;
  esac
fi
if [ "$#" -gt 0 ]; then
  echo "Usage: install.sh [--global|--local]" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or later is required. Install Node.js first." >&2
  exit 1
fi
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 20) { console.error("Node.js 20 or later is required."); process.exit(1); }'

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-vault-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
ARCHIVE="$TMP_DIR/source.tar.gz"
DOWNLOADED=0

if [ -n "${AGENT_VAULT_ARCHIVE_URL:-}" ]; then
  if ! curl --fail --silent --show-error --location "$AGENT_VAULT_ARCHIVE_URL" --output "$ARCHIVE"; then
    echo "Could not download Agent Vault archive." >&2
    exit 1
  fi
  DOWNLOADED=1
elif command -v gh >/dev/null 2>&1; then
  if gh api "repos/$REPOSITORY/tarball/$REF" >"$ARCHIVE" 2>/dev/null; then
    DOWNLOADED=1
  fi
fi

if [ "$DOWNLOADED" -eq 0 ]; then
  ARCHIVE_URL="https://codeload.github.com/$REPOSITORY/tar.gz/refs/heads/$REF"
  AUTH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$AUTH_TOKEN" ]; then
    CURL_CONFIG="$TMP_DIR/curl.conf"
    printf 'header = "Authorization: Bearer %s"\n' "$AUTH_TOKEN" >"$CURL_CONFIG"
    chmod 600 "$CURL_CONFIG"
    if ! curl --config "$CURL_CONFIG" --fail --silent --show-error --location "$ARCHIVE_URL" --output "$ARCHIVE"; then
      echo "Could not download Agent Vault archive. Check GitHub access and token permissions." >&2
      exit 1
    fi
  elif ! curl --fail --silent --show-error --location "$ARCHIVE_URL" --output "$ARCHIVE"; then
    echo "Could not download Agent Vault archive. For a private repository, install GitHub CLI, run 'gh auth login', or set GH_TOKEN." >&2
    exit 1
  fi
fi

SOURCE_DIR="$TMP_DIR/source"
mkdir -p "$SOURCE_DIR"
if ! tar -xzf "$ARCHIVE" -C "$SOURCE_DIR" --strip-components=1; then
  echo "Downloaded archive is invalid or could not be extracted." >&2
  exit 1
fi
if [ ! -f "$SOURCE_DIR/bin/vault-cli.mjs" ]; then
  echo "Downloaded archive does not contain the Agent Vault CLI." >&2
  exit 1
fi

node "$SOURCE_DIR/bin/vault-cli.mjs" install "$SCOPE"
