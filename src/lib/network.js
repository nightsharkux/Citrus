'use strict';
/** Local network addresses, so phones and tablets on the same Wi-Fi can open Campus OS. */
const os = require('node:os');

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** IPv4 addresses of this machine that other devices can reach, private ranges first. */
function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const e of entries || []) {
      if (e.family !== 'IPv4' || e.internal || e.address.startsWith('169.254.')) continue;
      // Skip virtual adapters (WSL, Hyper-V, Docker, VPNs) that phones cannot reach.
      if (/vEthernet|WSL|Hyper-V|docker|br-|virbr|vmnet|VirtualBox|tailscale|ZeroTier/i.test(name)) continue;
      found.push(e.address);
    }
  }
  return [...new Set(found)].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

/** True when the server listens on every interface (reachable from other devices). */
const listensOnNetwork = (host) => host === '0.0.0.0' || host === '::' || host === '';

function networkUrls(host, port) {
  return listensOnNetwork(host) ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [];
}

module.exports = { lanAddresses, listensOnNetwork, networkUrls };
