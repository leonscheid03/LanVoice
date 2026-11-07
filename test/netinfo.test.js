'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listLanAddresses } = require('../server/netinfo');

const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });

test('Adressen: Loopback/Link-Local/IPv6 raus, virtuelle Adapter ans Ende, 192.168 vor 10.', () => {
  const list = listLanAddresses({
    'vEthernet (WSL)': [v4('172.28.0.1')],
    Loopback: [v4('127.0.0.1', true)],
    Ethernet: [v4('10.0.0.7'), { family: 'IPv6', address: 'fe80::1', internal: false }],
    'WLAN': [v4('192.168.178.20'), v4('169.254.3.4')],
  });
  assert.deepEqual(list.map((a) => a.address), ['192.168.178.20', '10.0.0.7', '172.28.0.1']);
  assert.equal(list[2].virtual, true);
});
