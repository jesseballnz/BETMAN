#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# BETMAN + SportR — Unified Install Script
# The Ball Capital Office · Probabilistic Capital Allocation Engine
# SLA target: 99.999%
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

BETMAN_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Colours ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

banner(){
  echo ""
  echo -e "${CYAN}${BOLD}╔════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║          BETMAN + SportR · Unified Installer           ║${NC}"
  echo -e "${CYAN}${BOLD}║       The Ball Capital Office · Launch Edition         ║${NC}"
  echo -e "${CYAN}${BOLD}╚════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }
ask()   { echo -en "${CYAN}[?]${NC} $1 "; }

# ── Pre-flight checks ────────────────────────────────────────────
preflight(){
  info "Running pre-flight checks…"

  command -v node  >/dev/null 2>&1 || fail "Node.js not found. Install Node >= 20: https://nodejs.org"
  command -v npm   >/dev/null 2>&1 || fail "npm not found."

  local node_major
  node_major=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if (( node_major < 20 )); then
    fail "Node.js >= 20 required (found v${node_major}). Upgrade: https://nodejs.org"
  fi
  info "Node.js v$(node --version | tr -d 'v') ✓"

  if command -v python3 >/dev/null 2>&1; then
    info "Python3 $(python3 --version 2>&1 | awk '{print $2}') ✓  (needed for success_tracker)"
  else
    warn "Python3 not found — success_tracker.py won't run. Install if needed."
  fi
}

# ── Prompt helpers ────────────────────────────────────────────────
prompt_value(){
  local prompt="$1" default="${2:-}" var_name="$3"
  if [[ -n "$default" ]]; then
    ask "$prompt [${default}]:"
  else
    ask "$prompt:"
  fi
  local reply
  read -r reply
  reply="${reply:-$default}"
  eval "$var_name=\"\$reply\""
}

prompt_secret(){
  local prompt="$1" var_name="$2"
  ask "$prompt:"
  local reply
  read -rs reply
  echo ""
  eval "$var_name=\"\$reply\""
}

prompt_yn(){
  local prompt="$1" default="${2:-y}"
  ask "$prompt [${default}]:"
  local reply
  read -r reply
  reply="${reply:-$default}"
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}

# ── Ollama configuration ─────────────────────────────────────────
configure_ollama(){
  echo ""
  echo -e "${BOLD}── Ollama (Local AI) Configuration ──${NC}"
  echo ""
  echo "  BETMAN uses Ollama for local AI inference (race analysis, chat)."
  echo "  You can provide one or more Ollama base URLs."
  echo "  Common paths:"
  echo "    • Local:   http://127.0.0.1:11434"
  echo "    • Remote:  http://your-server:11434"
  echo ""

  OLLAMA_BASES=()
  local idx=1
  while true; do
    local default_hint=""
    if (( idx == 1 )); then
      default_hint="http://127.0.0.1:11434"
    fi
    prompt_value "Ollama base URL #${idx} (blank to finish)" "$default_hint" "ollama_url"
    if [[ -z "$ollama_url" ]]; then
      break
    fi
    # Strip trailing slash
    ollama_url="${ollama_url%/}"
    OLLAMA_BASES+=("$ollama_url")
    info "Added Ollama endpoint: ${ollama_url}"
    idx=$((idx + 1))
  done

  if (( ${#OLLAMA_BASES[@]} == 0 )); then
    warn "No Ollama endpoints configured. AI will require OpenAI or won't work."
  else
    info "${#OLLAMA_BASES[@]} Ollama endpoint(s) configured."
  fi

  prompt_value "Preferred Ollama model" "deepseek-r1:8b" "OLLAMA_MODEL"
}

# ── OpenAI configuration ─────────────────────────────────────────
configure_openai(){
  echo ""
  echo -e "${BOLD}── OpenAI Configuration ──${NC}"
  echo ""
  echo "  OpenAI is optional. If configured, admin users can route queries to GPT models."
  echo ""

  OPENAI_KEY=""
  OPENAI_MODEL=""
  if prompt_yn "Configure OpenAI API access?" "n"; then
    prompt_secret "OpenAI API key (sk-…)" "OPENAI_KEY"
    if [[ -z "$OPENAI_KEY" ]]; then
      warn "No OpenAI key provided — skipping."
    else
      prompt_value "Default OpenAI model" "gpt-4o-mini" "OPENAI_MODEL"
      info "OpenAI configured: model=${OPENAI_MODEL}"
    fi
  else
    info "OpenAI skipped."
  fi
}

# ── BETMAN auth ───────────────────────────────────────────────────
configure_auth(){
  echo ""
  echo -e "${BOLD}── BETMAN Authentication ──${NC}"
  echo ""

  prompt_value "Admin username" "betman" "BETMAN_USER"
  prompt_secret "Admin password (min 8 chars)" "BETMAN_PASS"
  while (( ${#BETMAN_PASS} < 8 )); do
    warn "Password must be at least 8 characters."
    prompt_secret "Admin password (min 8 chars)" "BETMAN_PASS"
  done
  info "Auth configured for user: ${BETMAN_USER}"
}

# ── Database ──────────────────────────────────────────────────────
configure_database(){
  echo ""
  echo -e "${BOLD}── Database Configuration ──${NC}"
  echo ""
  echo "  PostgreSQL is optional. Without it, BETMAN uses local JSON files."
  echo ""

  DATABASE_URL=""
  if prompt_yn "Configure PostgreSQL?" "n"; then
    prompt_value "Database URL (postgres://user:pass@host:5432/db)" "" "DATABASE_URL"
    if [[ -n "$DATABASE_URL" ]]; then
      info "PostgreSQL configured."
    else
      warn "No database URL — using file-based storage."
    fi
  else
    info "Using file-based storage (no PostgreSQL)."
  fi
}

# ── Stripe ────────────────────────────────────────────────────────
configure_stripe(){
  echo ""
  echo -e "${BOLD}── Stripe (Payments) Configuration ──${NC}"
  echo ""

  STRIPE_SECRET=""
  STRIPE_WEBHOOK_SECRET=""
  if prompt_yn "Configure Stripe payments?" "n"; then
    prompt_secret "Stripe secret key (sk_…)" "STRIPE_SECRET"
    prompt_secret "Stripe webhook secret (whsec_…)" "STRIPE_WEBHOOK_SECRET"
    if [[ -n "$STRIPE_SECRET" ]]; then
      info "Stripe configured."
    else
      warn "No Stripe key provided — payments disabled."
    fi
  else
    info "Stripe skipped."
  fi
}

# ── Ports ─────────────────────────────────────────────────────────
configure_ports(){
  echo ""
  echo -e "${BOLD}── Network Ports ──${NC}"
  echo ""

  prompt_value "BETMAN server port" "8080" "BETMAN_PORT"
  prompt_value "SportR server port" "9080" "SPORTR_PORT"
  info "BETMAN → :${BETMAN_PORT}  |  SportR → :${SPORTR_PORT}"
}

# ── Write .env files ──────────────────────────────────────────────
write_env(){
  info "Writing environment files…"

  local env_file="${BETMAN_ROOT}/.env"
  local sportr_env="${BETMAN_ROOT}/sporter/.env"

  # ── Main BETMAN .env ──
  {
    echo "# ── BETMAN .env — generated by install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) ──"
    echo ""
    echo "# Server"
    echo "PORT=${BETMAN_PORT}"
    echo ""
    echo "# Auth"
    echo "BETMAN_USERNAME=${BETMAN_USER}"
    echo "BETMAN_PASSWORD=${BETMAN_PASS}"
    echo ""
    echo "# Ollama (Local AI)"
    if (( ${#OLLAMA_BASES[@]} > 0 )); then
      echo "BETMAN_OLLAMA_BASE_URL=${OLLAMA_BASES[0]}"
      if (( ${#OLLAMA_BASES[@]} > 1 )); then
        local fallbacks
        fallbacks=$(IFS=,; echo "${OLLAMA_BASES[*]:1}")
        echo "BETMAN_OLLAMA_BASE_FALLBACKS=${fallbacks}"
      fi
    fi
    echo "BETMAN_CHAT_MODEL=${OLLAMA_MODEL}"
    echo "BETMAN_CHAT_PROVIDER=ollama"
    echo ""
    echo "# OpenAI (optional)"
    if [[ -n "$OPENAI_KEY" ]]; then
      echo "BETMAN_OPENAI_API_KEY=${OPENAI_KEY}"
      echo "BETMAN_OPENAI_MODEL=${OPENAI_MODEL}"
    else
      echo "# BETMAN_OPENAI_API_KEY="
      echo "# BETMAN_OPENAI_MODEL=gpt-4o-mini"
    fi
    echo ""
    echo "# Database (optional)"
    if [[ -n "$DATABASE_URL" ]]; then
      echo "DATABASE_URL=${DATABASE_URL}"
    else
      echo "# DATABASE_URL="
    fi
    echo ""
    echo "# Stripe (optional)"
    if [[ -n "$STRIPE_SECRET" ]]; then
      echo "STRIPE_SECRET_KEY=${STRIPE_SECRET}"
      echo "STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}"
    else
      echo "# STRIPE_SECRET_KEY="
      echo "# STRIPE_WEBHOOK_SECRET="
    fi
    echo ""
    echo "# Privacy — log redaction enabled by default"
    echo "BETMAN_REDACT_LOGS=true"
  } > "$env_file"
  chmod 600 "$env_file"
  info "Wrote ${env_file}"

  # ── SportR .env ──
  {
    echo "# ── SportR .env — generated by install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) ──"
    echo "PORT=${SPORTR_PORT}"
    echo "HOST=0.0.0.0"
  } > "$sportr_env"
  chmod 600 "$sportr_env"
  info "Wrote ${sportr_env}"
}

# ── Install dependencies ──────────────────────────────────────────
install_deps(){
  echo ""
  info "Installing BETMAN dependencies…"
  cd "$BETMAN_ROOT"
  npm ci --no-audit --no-fund 2>&1 | tail -2

  echo ""
  info "Installing SportR dependencies…"
  cd "$BETMAN_ROOT/sporter"
  npm ci --no-audit --no-fund 2>&1 | tail -2 || npm install --no-audit --no-fund 2>&1 | tail -2

  cd "$BETMAN_ROOT"
}

# ── Create runtime directories ────────────────────────────────────
create_dirs(){
  info "Creating runtime directories…"
  mkdir -p "$BETMAN_ROOT/memory"
  mkdir -p "$BETMAN_ROOT/memory/tenants"
  mkdir -p "$BETMAN_ROOT/frontend/data"
  mkdir -p "$BETMAN_ROOT/sporter/data"
  mkdir -p "$BETMAN_ROOT/bakeoff/results"
  mkdir -p "$BETMAN_ROOT/data/meeting_profiles/today"
}

# ── Verify installation ──────────────────────────────────────────
verify(){
  echo ""
  info "Running verification tests…"
  cd "$BETMAN_ROOT"

  if npm test 2>&1 | tail -5; then
    info "All tests passed ✓"
  else
    warn "Some tests failed — check output above."
  fi
}

# ── Print summary ─────────────────────────────────────────────────
print_summary(){
  echo ""
  echo -e "${GREEN}${BOLD}╔════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║              Installation Complete ✓                   ║${NC}"
  echo -e "${GREEN}${BOLD}╚════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${BOLD}Start BETMAN:${NC}   cd ${BETMAN_ROOT} && node scripts/frontend_server.js"
  echo -e "  ${BOLD}Start SportR:${NC}   cd ${BETMAN_ROOT}/sporter && node scripts/sporter_server.js"
  echo -e "  ${BOLD}Start poller:${NC}   cd ${BETMAN_ROOT} && npm run jobs:run"
  echo ""
  echo -e "  ${BOLD}BETMAN URL:${NC}     http://localhost:${BETMAN_PORT}"
  echo -e "  ${BOLD}SportR URL:${NC}     http://localhost:${SPORTR_PORT}"
  echo ""
  if (( ${#OLLAMA_BASES[@]} > 0 )); then
    echo -e "  ${BOLD}Ollama:${NC}         ${OLLAMA_BASES[0]}  model=${OLLAMA_MODEL}"
  fi
  if [[ -n "$OPENAI_KEY" ]]; then
    echo -e "  ${BOLD}OpenAI:${NC}         Configured  model=${OPENAI_MODEL}"
  fi
  if [[ -n "$DATABASE_URL" ]]; then
    echo -e "  ${BOLD}Database:${NC}       PostgreSQL configured"
  fi
  echo ""
  echo -e "  ${BOLD}Config files:${NC}   .env  sporter/.env"
  echo -e "  ${BOLD}Run tests:${NC}      npm test"
  echo ""
  echo -e "  ${YELLOW}⚠  Keep your .env files secure — they contain secrets.${NC}"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────
main(){
  banner
  preflight
  configure_ollama
  configure_openai
  configure_auth
  configure_database
  configure_stripe
  configure_ports
  write_env
  create_dirs
  install_deps
  verify
  print_summary
}

main "$@"
