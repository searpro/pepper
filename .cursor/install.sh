#!/usr/bin/env bash
set -euo pipefail

npm ci

# Local dev needs upstream sdcpp releases for CPU Linux; the default repo only
# publishes a CUDA prerelease.
if [[ ! -f server/.env ]]; then
  cp server/.env.example server/.env
  echo 'SDCPP_RELEASE_REPO=leejet/stable-diffusion.cpp' >> server/.env
fi
