const http = require('http');

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/auth/ping',
  method: 'GET'
};

console.log('Testing backend connectivity...');
console.log('URL: http://localhost:5000/api/auth/ping');

const req = http.request(options, (res) => {
  console.log('✅ Connected! Status:', res.statusCode);
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    console.log('Response:', data);
    process.exit(0);
  });
});

req.on('error', (err) => {
  console.log('❌ Error:', err.message);
  process.exit(1);
});

req.end();
