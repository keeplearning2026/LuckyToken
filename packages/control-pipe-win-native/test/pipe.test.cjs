'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { NativePipeServer, currentUserSid } = require('..');

function uniquePipe() {
  return `\\\\.\\pipe\\LuckyToken-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('reports the current process TokenUser SID independently', () => {
  assert.equal(typeof currentUserSid, 'function');
  assert.match(currentUserSid(), /^S-1-/);
});

test('same-user client exchanges raw bytes and the pipe has the required policy', async () => {
  const pipeName = uniquePipe();
  const server = new NativePipeServer(pipeName);
  const policy = server.securityPolicy();
  assert.match(policy.ownerSid, /^S-1-/);
  assert.equal(policy.daclProtected, true);
  assert.equal(policy.accessMask, 0x0012019f);
  assert.equal(policy.rejectRemoteClients, true);

  const accepted = server.accept();
  const client = net.connect(pipeName);
  await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
  const connection = await accepted;

  client.write(Buffer.from('ping'));
  assert.deepEqual(await connection.read(1024), Buffer.from('ping'));
  await connection.write(Buffer.from('pong'));
  assert.deepEqual(await new Promise((resolve, reject) => {
    client.once('data', resolve).once('error', reject);
  }), Buffer.from('pong'));

  connection.close();
  server.close();
  client.destroy();
});

test('close cancels a pending accept and pending read without hanging', async () => {
  const server = new NativePipeServer(uniquePipe());
  const pendingAccept = server.accept();
  server.close();
  await assert.rejects(pendingAccept);

  const pipeName = uniquePipe();
  const connectedServer = new NativePipeServer(pipeName);
  const accepted = connectedServer.accept();
  const client = net.connect(pipeName);
  await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
  const connection = await accepted;
  const pendingRead = connection.read(1024);
  connection.close();
  let timeout;
  try {
    await Promise.race([
      assert.rejects(pendingRead),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('read did not cancel')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  connectedServer.close();
  client.destroy();
});

test('read reports peer EOF as null and accept-close races settle without a panic', async () => {
  const pipeName = uniquePipe();
  const server = new NativePipeServer(pipeName);
  const accepted = server.accept();
  const client = net.connect(pipeName);
  await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
  const connection = await accepted;
  client.end();
  assert.equal(await connection.read(1024), null);
  connection.close();
  server.close();

  for (let index = 0; index < 25; index += 1) {
    const racingServer = new NativePipeServer(uniquePipe());
    const pending = racingServer.accept();
    racingServer.close();
    await assert.rejects(pending, /closed|ConnectNamedPipe/);
  }
});
