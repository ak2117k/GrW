// Simple health check — verifies backend connectivity
const API_URL = process.env.TD_API_URL || 'http://localhost:4001';

async function check() {
  try {
    const res = await fetch(`${API_URL}/api/broker/status`);
    const data = await res.json();
    console.log('✓ Backend reachable');
    console.log('  Broker connected:', data.connected);
    console.log('  Client ID:', data.clientId);

    const marketRes = await fetch(`${API_URL}/api/market-data/market-status`);
    const market = await marketRes.json();
    console.log('✓ Market data service OK');
    console.log('  Market status:', JSON.stringify(market));
  } catch (err) {
    console.error('✗ Backend NOT reachable at', API_URL);
    console.error('  Make sure the NestJS server is running: npm run dev:api');
    process.exit(1);
  }
}

check();
