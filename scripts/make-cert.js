'use strict';
// Creates a self-signed HTTPS certificate in ./certs (needs the "openssl" command).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getLanAddresses } = require('../server/lan');

const dir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(dir, { recursive: true });
const ips = getLanAddresses().map((a) => 'IP:' + a.address);
if (process.env.HOST_IP) ips.unshift('IP:' + process.env.HOST_IP);
const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips].join(',');

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=' + san,
  ], { stdio: 'inherit' });
  console.log('\nCertificate created in ./certs for: ' + san);
  console.log('Restart the server (npm start). Your browsers will show a one-time warning - accept it.');
} catch (e) {
  console.error('\nCould not run openssl (' + (e.code || e.message) + ').');
  console.error('Alternatives: install "mkcert" and run:  mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 <your-LAN-IP>');
  console.error('or use a tunnel (see README).');
  process.exit(1);
}
