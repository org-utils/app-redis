#!/bin/sh
# Boots a 6-node Redis Cluster (3 masters + 3 replicas) inside one container.
set -e
cd /data

for port in 7000 7001 7002 7003 7004 7005; do
  mkdir -p node-$port
  cat > node-$port/redis.conf <<EOF
port $port
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000
appendonly yes
appendfilename appendonly-$port.aof
dir /data/node-$port
bind 0.0.0.0
protected-mode no
EOF
  redis-server node-$port/redis.conf &
done

sleep 2

redis-cli --cluster create \
  127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
  127.0.0.1:7003 127.0.0.1:7004 127.0.0.1:7005 \
  --cluster-replicas 1 --cluster-yes

sleep infinity
