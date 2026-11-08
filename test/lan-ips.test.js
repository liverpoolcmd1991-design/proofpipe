import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanIPs } from '../server/util.js';

// The pairing QR encodes lanIPs()[0]. A VPN adapter carries a private IP in the
// same ranges a hotspot uses, so picking by range alone handed the phone an
// address that exists only on the PC. These pin the ORDER, which is the contract.

const nic = (...addresses) =>
  addresses.map(address => ({ address, family: 'IPv4', internal: false }));

test('a VPN adapter never outranks the real Wi-Fi, even in the same 10.x range', () => {
  // the exact shape that broke pairing: hotspot 10.179.242.175 + Windscribe
  // IKEv2 10.189.137.195 — both score 1 on range alone, so interface order won
  const ips = lanIPs({
    'Windscribe IKEv2': nic('10.189.137.195'),
    'Wi-Fi': nic('10.179.242.175'),
  });
  assert.deepEqual(ips, ['10.179.242.175', '10.189.137.195']);
});

test('tunnel adapters of every common vendor rank last', () => {
  const ips = lanIPs({
    'TAP-Windows Adapter V9': nic('10.8.0.2'),
    'WireGuard Tunnel': nic('10.64.0.1'),
    'Tailscale': nic('100.101.102.103'),
    'Wi-Fi': nic('192.168.1.20'),
  });
  assert.equal(ips[0], '192.168.1.20', 'the real NIC is first');
  assert.equal(ips.length, 4, 'virtual adapters stay in the list, just last');
  assert.deepEqual(ips.slice(1).sort(), ['100.101.102.103', '10.64.0.1', '10.8.0.2'].sort());
});

test('real LAN ranges keep their existing precedence: 192.168, then 10', () => {
  const ips = lanIPs({
    'Ethernet 3': nic('203.0.113.9'),
    'Ethernet 2': nic('172.20.10.2'), // mobile hotspot
    'Wi-Fi': nic('10.0.0.5'),
    'Ethernet': nic('192.168.43.7'), // Android hotspot
  });
  assert.equal(ips[0], '192.168.43.7');
  assert.equal(ips[1], '10.0.0.5');
});

test('docker/WSL virtual switches rank below a 172.20 hotspot', () => {
  const ips = lanIPs({
    'vEthernet (WSL (Hyper-V firewall))': nic('172.29.0.1'),
    'Wi-Fi': nic('172.20.10.2'),
  });
  assert.deepEqual(ips, ['172.20.10.2', '172.29.0.1']);
});

test('loopback and IPv6 entries are never advertised', () => {
  const ips = lanIPs({
    'Wi-Fi': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.4', family: 'IPv4', internal: false },
    ],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  });
  assert.deepEqual(ips, ['192.168.1.4']);
});

test('a machine with only a VPN still reports it (nothing is dropped)', () => {
  const ips = lanIPs({ 'Windscribe IKEv2': nic('10.189.137.195') });
  assert.deepEqual(ips, ['10.189.137.195']);
});

test('APIPA link-local 169.254.x.x addresses rank below real LAN and 172.x interfaces', () => {
  const ips = lanIPs({
    'eth0': nic('169.254.8.1', '169.254.169.1'),
    'Wi-Fi': nic('172.20.10.2'),
  });
  assert.equal(ips[0], '172.20.10.2', 'routable hotspot beats link-local 169.254.x.x');
});

