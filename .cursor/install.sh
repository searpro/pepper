#!/usr/bin/env bash
set -euo pipefail

npm ci

# Local dev needs upstream sdcpp releases for CPU Linux; the default repo only
# publishes a CUDA prerelease.
if [[ ! -f apps/pepper/server/.env ]]; then
  cp apps/pepper/server/.env.example apps/pepper/server/.env
  echo 'SDCPP_RELEASE_REPO=leejet/stable-diffusion.cpp' >> apps/pepper/server/.env
fi
