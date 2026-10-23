#!/usr/bin/env bash
set -euo pipefail

apply() {
  local cmd=$1 url=$2
  "$cmd" -N HOOK-CF 2>/dev/null || "$cmd" -F HOOK-CF
  for range in $(curl -fsS "$url"); do "$cmd" -A HOOK-CF -s "$range" -j RETURN; done
  "$cmd" -A HOOK-CF -j DROP
  "$cmd" -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 -j HOOK-CF 2>/dev/null \
    || "$cmd" -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 -j HOOK-CF
  "$cmd" -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 -j HOOK-CF 2>/dev/null \
    || "$cmd" -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 -j HOOK-CF
}

apply iptables https://www.cloudflare.com/ips-v4
apply ip6tables https://www.cloudflare.com/ips-v6
echo "Ports 80 and 443 now accept Cloudflare only"
