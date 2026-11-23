#!/usr/bin/env bash
# Linux integration test; requires a Pi binary that honors PI_CODING_AGENT_DIR, script, and jq.
set -euo pipefail
pi=${PI_BIN:?Set PI_BIN to the absolute path of the Pi binary, not a wrapper}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/agent" "$tmp/project/.pi" "$tmp/other" "$tmp/fixture/extensions" "$tmp/fixture/skills/proof" "$tmp/fixture/prompts"
jq -n --arg manager "$root" --arg fixture "$tmp/fixture" '{defaultProjectTrust: "always", packages: [$manager, $fixture]}' > "$tmp/agent/settings.json"
printf '{}\n' > "$tmp/project/.pi/settings.json"
printf '%s\n' 'export default (pi) => pi.registerCommand("fixture-proof", { description: "Proof", handler: async () => {} });' > "$tmp/fixture/extensions/proof.ts"
printf '%s\n' '---' 'name: proof' 'description: An integration test fixture.' '---' 'Proof.' > "$tmp/fixture/skills/proof/SKILL.md"
printf 'Proof.\n' > "$tmp/fixture/prompts/proof-prompt.md"
export PI_CODING_AGENT_DIR="$tmp/agent" TERM=xterm-256color
export SMOKE_PI="$pi"

check() {
  local dir=$1 want=$2 reply
  reply=$(cd "$tmp/$dir"; { printf '%s\n' '{"type":"get_commands"}'; sleep 0.8; } | "$pi" --offline --no-session --mode rpc 2>/dev/null)
  jq -e --argjson want "$want" '[.data.commands[].name] | (index("extensions") != null) and ((index("fixture-proof") != null) == $want) and ((index("skill:proof") != null) == $want) and ((index("proof-prompt") != null) == $want)' <<< "$reply" >/dev/null
}

send_command() {
  local part
  : > "$tmp/tui.log"
  (cd "$tmp/project"; {
    for ((i = 0; i < 40; i++)); do
      if grep -q 'No models available' "$tmp/tui.log"; then break; fi
      sleep 0.1
    done
    for part in "$@"; do sleep 0.35; printf '%s' "$part"; done
    sleep 0.35
    local menu_seen=yes
    if [[ ${expect_menu:-} == yes ]]; then
      menu_seen=no
      for ((i = 0; i < 25; i++)); do
        if grep -Fq 'Enable a package' "$tmp/tui.log"; then menu_seen=yes; break; fi
        sleep 0.1
      done
    else
      printf '\r'
    fi
    sleep 0.8; printf '\033'
    sleep 0.7; printf '\003'
    sleep 0.55; printf '\004'
    [[ $menu_seen == yes ]]
  } | timeout 12 script -f -q -e -c 'stty rows 30 cols 100; "$SMOKE_PI" --offline --no-session' "$tmp/tui.log" >/dev/null) || {
    strings "$tmp/tui.log" | grep -Ei 'exten|enable|disable|error' | tail -25 >&2
    return 1
  }
}

check project true
expect_menu=yes send_command '/exten' $'\t'
cp "$tmp/agent/settings.json" "$tmp/before.json"
send_command '/extensions disable fixture'
cmp <(jq -c .packages "$tmp/before.json") <(jq -c .packages "$tmp/agent/settings.json")
check project true
send_command '/extensions dis' $'\t' 'fix' $'\t' '--g' $'\t'
grep -Fq 'Settings saved.' "$tmp/tui.log" || { strings "$tmp/tui.log" | tail -100 >&2; exit 1; }
jq -e '.packages[1]["x-pi-ext"].mode == "disable"' "$tmp/agent/settings.json" >/dev/null
check project false
send_command '/extensions enable fixture --project'
check project true
check other false
send_command '/extensions inherit fixture'
check project false
send_command '/extensions enable fixture --global'
check project true
send_command '/extensions disable fixture --project'
check project false
check other true
send_command '/extensions inherit fixture'
check project true
printf 'Pi smoke test passed.\n'
