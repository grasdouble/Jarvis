#!/usr/bin/env bash

docker_cli_version_is_compatible() {
  [[ "$1" =~ ^${DOCKER_CLI_COMPATIBLE_MAJOR}\.[0-9]+\.[0-9]+$ ]]
}
