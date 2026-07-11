#!/bin/bash
# Provision the fedora-desktop container for pi-codex development.
# Run inside the container as root: docker exec fedora-desktop bash /config/workspace/setup-container.sh
set -e
dnf install -y git nodejs npm ripgrep
npm install -g @earendil-works/pi-coding-agent
su abc -c 'git config --global user.name "john" && git config --global user.email "vishwa.wenga@gmail.com"'
echo "=== versions ==="
git --version && node --version && pi --version
