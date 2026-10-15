'use strict';
// Finds this computer's address on the local network (e.g. 192.168.1.23),
// so the QR code can point the phone at the laptop instead of "localhost".
const os = require('os');

const VIRTUAL = /vbox|virtual|vmware|docker|veth|wsl|vethernet|br-|utun|tailscale|zerotier/i;

function getLanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      const isV4 = i.family === 'IPv4' || i.family === 4;
      if (isV4 && !i.internal) found.push({ name, address: i.address });
    }
  }
  // Prefer typical home/office Wi-Fi ranges and avoid virtual adapters.
  const rank = ({ name, address }) => {
    let r = address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 :
            /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3;
    if (VIRTUAL.test(name)) r += 10;
    return r;
  };
  return found.sort((a, b) => rank(a) - rank(b));
}

module.exports = { getLanAddresses };
