#!/bin/sh

set -u
LC_ALL=C
export LC_ALL
umask 077

configure=0
if [ "$#" -eq 1 ] && [ "$1" = '--configure' ]; then
  configure=1
elif [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: ensure-credential.sh [--configure]' >&2
  exit 64
fi

if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config_root=$XDG_CONFIG_HOME
elif [ -n "${HOME:-}" ]; then
  config_root=$HOME/.config
else
  printf '%s\n' 'No user configuration directory is available.' >&2
  exit 1
fi

config_dir=$config_root/yesmore/landing-dev
credential_file=$config_dir/credential
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
store_script=$script_dir/store-credential.sh
success_marker=
failure_marker=
terminal_window_id=

valid_token() {
  case "$1" in
    ymb_*) token_suffix=${1#ymb_} ;;
    *) return 1 ;;
  esac
  case "$token_suffix" in
    ''|*[!A-Za-z0-9_-]*) token_suffix=; return 1 ;;
    *) token_suffix=; return 0 ;;
  esac
}

portable_mode() {
  mode_path=$1
  if stat -f '%Lp' "$mode_path" >/dev/null 2>&1; then
    stat -f '%Lp' "$mode_path"
  else
    stat -c '%a' "$mode_path"
  fi
}

valid_stored_credential() {
  [ -d "$config_dir" ] || return 1
  [ ! -L "$config_dir" ] || return 1
  [ "$(portable_mode "$config_dir" 2>/dev/null)" = 700 ] || return 1
  [ -f "$credential_file" ] || return 1
  [ ! -L "$credential_file" ] || return 1
  [ "$(portable_mode "$credential_file" 2>/dev/null)" = 600 ] || return 1

  stored_bytes=$(wc -c < "$credential_file" 2>/dev/null | tr -d ' ') || return 1
  stored_value=$(LC_ALL=C command cat "$credential_file" 2>/dev/null) || return 1
  case "$stored_bytes" in
    ''|*[!0-9]*) stored_value=; return 1 ;;
  esac
  [ "$stored_bytes" -eq "${#stored_value}" ] || { stored_value=; return 1; }
  valid_token "$stored_value"
  stored_status=$?
  stored_value=
  return "$stored_status"
}

if [ "${YESMORE_LANDING_BUNDLE_TOKEN+x}" = x ]; then
  if [ "$configure" -eq 1 ]; then
    printf '%s\n' 'YESMORE_LANDING_BUNDLE_TOKEN has precedence. Update or remove that host-managed encrypted secret, then run configure again.' >&2
    exit 2
  fi
  if valid_token "$YESMORE_LANDING_BUNDLE_TOKEN"; then
    exit 0
  fi
  printf '%s\n' 'YESMORE_LANDING_BUNDLE_TOKEN is invalid. Update or remove that host-managed encrypted secret; do not provide it in chat.' >&2
  exit 2
fi

if [ "$configure" -eq 0 ] && valid_stored_credential; then
  exit 0
fi

mkdir -p "$config_dir" || exit 1
if [ ! -d "$config_dir" ] || [ -L "$config_dir" ]; then
  printf '%s\n' 'The credential directory must be a real directory.' >&2
  exit 1
fi
chmod 700 "$config_dir" || exit 1

file_identity() {
  if [ ! -e "$credential_file" ]; then
    printf '%s\n' 'missing'
  elif stat -f '%d:%i:%z:%m' "$credential_file" >/dev/null 2>&1; then
    stat -f '%d:%i:%z:%m' "$credential_file"
  else
    stat -c '%d:%i:%s:%Y' "$credential_file"
  fi
}

before_identity=$(file_identity) || exit 1
nonce=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
if [ "${#nonce}" -ne 32 ]; then
  printf '%s\n' 'Could not generate a secure non-secret configuration nonce.' >&2
  exit 1
fi

success_marker=$config_dir/.credential-result-$nonce.success
failure_marker=$config_dir/.credential-result-$nonce.failure
rm -f "$success_marker" "$failure_marker"

cleanup_markers() {
  cleanup_status=$1
  trap - 0
  rm -f "$success_marker" "$failure_marker"
  exit "$cleanup_status"
}

close_launched_terminal() {
  [ -n "$terminal_window_id" ] || return 0
  osascript - "$terminal_window_id" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  set targetWindowId to (item 1 of argv) as integer
  tell application "Terminal"
    if exists window id targetWindowId then
      set targetWindow to window id targetWindowId
      repeat 20 times
        if not busy of selected tab of targetWindow then exit repeat
        delay 0.1
      end repeat
      if not busy of selected tab of targetWindow then close targetWindow
    end if
  end tell
end run
APPLESCRIPT
  terminal_window_id=
}

trap 'cleanup_markers $?' 0
trap 'exit 130' HUP INT TERM

launched=0
platform=$(uname -s 2>/dev/null || printf '%s' unknown)

if [ "$platform" = Darwin ] && command -v osascript >/dev/null 2>&1; then
  if terminal_window_output=$(osascript - "$store_script" "$nonce" "$config_root" <<'APPLESCRIPT'
on run argv
  set storePath to item 1 of argv
  set nonceValue to item 2 of argv
  set configRoot to item 3 of argv
  set launchCommand to "/usr/bin/env XDG_CONFIG_HOME=" & quoted form of configRoot & space & quoted form of storePath & space & quoted form of nonceValue
  tell application "Terminal"
    activate
    do script launchCommand
    return id of front window
  end tell
end run
APPLESCRIPT
  )
  then
    launched=1
    case "$terminal_window_output" in
      ''|*[!0-9]*) terminal_window_id= ;;
      *) terminal_window_id=$terminal_window_output ;;
    esac
    terminal_window_output=
  fi
fi

if [ "$launched" -eq 0 ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  if command -v x-terminal-emulator >/dev/null 2>&1; then
    x-terminal-emulator -e env "XDG_CONFIG_HOME=$config_root" "$store_script" "$nonce" >/dev/null 2>&1 &
    launched=1
  elif command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- env "XDG_CONFIG_HOME=$config_root" "$store_script" "$nonce" >/dev/null 2>&1 &
    launched=1
  elif command -v konsole >/dev/null 2>&1; then
    konsole -e env "XDG_CONFIG_HOME=$config_root" "$store_script" "$nonce" >/dev/null 2>&1 &
    launched=1
  elif command -v xfce4-terminal >/dev/null 2>&1; then
    xfce4-terminal -x env "XDG_CONFIG_HOME=$config_root" "$store_script" "$nonce" >/dev/null 2>&1 &
    launched=1
  elif command -v xterm >/dev/null 2>&1; then
    xterm -e env "XDG_CONFIG_HOME=$config_root" "$store_script" "$nonce" >/dev/null 2>&1 &
    launched=1
  fi
fi

if [ "$launched" -ne 1 ]; then
  printf '%s\n' 'No visible GUI terminal is available. Configure YESMORE_LANDING_BUNDLE_TOKEN through the host encrypted-secret facility; never provide the value in chat.' >&2
  exit 1
fi

elapsed=0
while [ "$elapsed" -lt 300 ]; do
  if [ -f "$failure_marker" ]; then
    printf '%s\n' 'Credential configuration was cancelled or failed validation.' >&2
    exit 1
  fi

  if [ -f "$success_marker" ]; then
    after_identity=$(file_identity) || exit 1
    if [ "$after_identity" = "$before_identity" ] || ! valid_stored_credential; then
      printf '%s\n' 'Credential configuration did not produce a newly valid protected file.' >&2
      exit 1
    fi
    close_launched_terminal
    exit 0
  fi

  sleep 1
  elapsed=$((elapsed + 1))
done

printf '%s\n' 'Credential configuration timed out after five minutes.' >&2
exit 1
