import fs from 'node:fs';
import { login, request } from '../tests/helpers.js';

const base = process.argv[2] || 'http://127.0.0.1:3000';

try {
  const cookie = await login(base);
  const users = await request(base, 'GET', '/api/users', null, cookie);
  fs.writeFileSync('live-users.txt', JSON.stringify(users, null, 2));
  const staff = users.data.users.find((u) => u.role === 'staff');
  if (!staff) {
    fs.writeFileSync('live-del.txt', 'no staff user');
    process.exit(0);
  }
  const del = await request(base, 'DELETE', `/api/users/${staff.id}`, null, cookie);
  fs.writeFileSync('live-del.txt', JSON.stringify(del, null, 2));
} catch (error) {
  fs.writeFileSync('live-del.txt', String(error.stack || error));
  process.exit(1);
}