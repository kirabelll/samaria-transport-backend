const http = require('http');

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = { hostname: 'localhost', port: 5000, path, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) })); });
    req.on('error', reject);
    if (body) req.write(data);
    req.end();
  });
}

(async () => {
  // Login
  const login = await post('/api/auth/login', { email: 'admin@wonde.et', password: 'Admin@1234' });
  if (!login.data.token) { console.log('Login failed:', JSON.stringify(login.data)); return; }
  const token = login.data.token;
  console.log('Login OK');

  // Test fleet-board
  const fb = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: 5000, path: '/api/vehicles/fleet-board', method: 'GET', headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) }));
    });
    req.on('error', reject); req.end();
  });
  console.log('Fleet board status:', fb.status, 'vehicles:', fb.data.vehicles?.length, 'summary:', JSON.stringify(fb.data.summary));

  // Test compliance scan
  const scan = await post('/api/vehicles/compliance-check-all', null, token);
  console.log('Scan status:', scan.status);
  if (scan.data.error) console.log('Scan error:', scan.data.error, scan.data.detail);
  else console.log('Scan results:', JSON.stringify({ locked: scan.data.locked, unlocked: scan.data.unlocked, compliant: scan.data.compliant, alreadyLocked: scan.data.alreadyLocked }));
})();
