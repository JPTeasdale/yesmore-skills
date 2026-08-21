#!/bin/sh

set -u
LC_ALL=C
export LC_ALL
umask 077

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: store-credential.sh <non-secret-nonce>' >&2
  exit 64
fi

nonce=$1
case "$nonce" in
  ''|*[!A-Za-z0-9_-]*)
    printf '%s\n' 'Invalid non-secret nonce.' >&2
    exit 64
    ;;
esac
if [ "${#nonce}" -gt 128 ]; then
  printf '%s\n' 'Invalid non-secret nonce.' >&2
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
success_marker=$config_dir/.credential-result-$nonce.success
failure_marker=$config_dir/.credential-result-$nonce.failure
credential_temp=$config_dir/.credential.$nonce.$$.tmp
marker_temp=$config_dir/.credential-result-$nonce.$$.tmp
echo_disabled=0
terminal_state=
completed=0

mkdir -p "$config_dir" || exit 1
if [ ! -d "$config_dir" ] || [ -L "$config_dir" ]; then
  printf '%s\n' 'The credential directory must be a real directory.' >&2
  exit 1
fi
chmod 700 "$config_dir" || exit 1

finish() {
  finish_status=$1
  trap - 0

  if [ "$echo_disabled" -eq 1 ] && [ -n "$terminal_state" ]; then
    stty "$terminal_state" < /dev/tty >/dev/null 2>&1 || true
  fi

  credential_value=
  rm -f "$credential_temp" "$marker_temp"

  if [ "$completed" -ne 1 ]; then
    printf '%s\n' 'failure' > "$marker_temp" 2>/dev/null || true
    chmod 600 "$marker_temp" 2>/dev/null || true
    mv "$marker_temp" "$failure_marker" 2>/dev/null || true
  fi

  exit "$finish_status"
}

trap 'finish $?' 0
trap 'exit 130' HUP INT TERM

terminal_state=$(stty -g < /dev/tty 2>/dev/null) || {
  printf '%s\n' 'A visible interactive terminal is required.' >&2
  exit 1
}

stty -echo < /dev/tty || exit 1
echo_disabled=1
printf '%s' 'Enter the YesMore landing bundle credential: ' > /dev/tty

credential_value=
if ! IFS= read -r credential_value < /dev/tty; then
  printf '\n' > /dev/tty
  printf '%s\n' 'Credential entry was cancelled.' >&2
  exit 1
fi

stty "$terminal_state" < /dev/tty >/dev/null 2>&1 || true
echo_disabled=0
printf '\n' > /dev/tty

case "$credential_value" in
  ymb_*) credential_suffix=${credential_value#ymb_} ;;
  *) credential_suffix= ;;
esac
case "$credential_suffix" in
  ''|*[!A-Za-z0-9_-]*)
    credential_value=
    credential_suffix=
    printf '%s\n' 'Credential format is invalid.' >&2
    exit 2
    ;;
esac
credential_suffix=

printf '%s' "$credential_value" > "$credential_temp" || exit 1
credential_value=
chmod 600 "$credential_temp" || exit 1
mv "$credential_temp" "$credential_file" || exit 1

rm -f "$failure_marker"
printf '%s\n' 'success' > "$marker_temp" || exit 1
chmod 600 "$marker_temp" || exit 1
mv "$marker_temp" "$success_marker" || exit 1

completed=1
printf '%s\n' 'YesMore credential stored securely.'
exit 0
