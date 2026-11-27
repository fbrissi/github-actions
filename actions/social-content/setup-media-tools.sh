#!/usr/bin/env bash
# Installs the media tools of the video-shorts skill on a Linux runner: ffmpeg and ffprobe, and Piper TTS in its own
# virtual environment, then exports PIPER_PYTHON for the agent. Image cards only need Docker, which is checked here.
set -euo pipefail

piper_version="${PIPER_TTS_VERSION:?PIPER_TTS_VERSION is required}"
venv="${PIPER_VENV:-${RUNNER_TEMP:?RUNNER_TEMP is required}/piper-venv}"

if ! command -v docker >/dev/null 2>&1; then
  echo '::warning::Docker is not available; the image-cards skill renders cards in a Playwright container.'
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends ffmpeg
fi
ffmpeg -hide_banner -version | head -n 1

python="$(command -v python3 || true)"
if [ -z "$python" ]; then
  echo '::error::python3 is required for Piper TTS (3.10 or newer).'
  exit 1
fi
if ! "$python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "::error::Piper TTS needs Python 3.10 or newer, found $("$python" --version 2>&1)."
  exit 1
fi

"$python" -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check "piper-tts==${piper_version}"
echo "Piper TTS ${piper_version} installed in ${venv}."

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "PIPER_PYTHON=$venv/bin/python" >> "$GITHUB_ENV"
fi
